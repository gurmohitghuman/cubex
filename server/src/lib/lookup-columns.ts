// Lookup columns' records (lookup_columns, migration 031): reading them, and
// keeping them in step with renames and deletes on BOTH sheets: this one (its
// own column and the column it reads, as clean columns do) and the sheet it
// looks in (its match and return columns). services/column-rename.ts,
// column-delete.ts, csv-import.ts and lib/import-undo.ts call these inside
// their transactions. Renaming a column there rewrites the record; deleting
// one it reads, or that sheet, sets `broken`: the lookup then stops with that
// message (never a silently wrong answer) until it is set up again.
import { db } from './db';
import { jsonPath } from './sql-rows';

export type LookupMatch = 'equals' | 'contains';
export type LookupReturns = 'value' | 'exists' | 'count' | 'list';

export interface LookupColumnRow {
  id: string; user_id: string; sheet_id: string; column_name: string; source_column: string;
  other_sheet_id: string; match_column: string; match_mode: LookupMatch; returns: LookupReturns;
  return_columns: string | null; list_limit: number; broken: string | null;
  fill_status: 'filling' | 'done' | 'failed'; fill_cursor: number; filled_rows: number; error_rows: number;
  first_error: string | null; error_message: string | null;
}

// The other sheet's columns it returns: one for 'value'; for 'list', null = all of them.
export function lookupReturnColumns(rec: Pick<LookupColumnRow, 'return_columns'>): string[] | null {
  if (rec.return_columns === null) return null;
  try {
    const v = JSON.parse(rec.return_columns);
    return Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

export function lookupColumnFor(sheetId: string, userId: string, column: string): LookupColumnRow | undefined {
  return db.prepare('SELECT * FROM lookup_columns WHERE sheet_id = ? AND user_id = ? AND column_name = ?')
    .get(sheetId, userId, column) as LookupColumnRow | undefined;
}

export function loadLookupColumn(id: string): LookupColumnRow | undefined {
  return db.prepare('SELECT * FROM lookup_columns WHERE id = ?').get(id) as LookupColumnRow | undefined;
}

export function sheetLookupColumns(sheetId: string, userId: string): LookupColumnRow[] {
  return db.prepare('SELECT * FROM lookup_columns WHERE sheet_id = ? AND user_id = ? ORDER BY created_at')
    .all(sheetId, userId) as LookupColumnRow[];
}

// Lookups that look in a sheet.
const lookingIn = (sheetId: string, userId: string): LookupColumnRow[] =>
  db.prepare('SELECT * FROM lookup_columns WHERE other_sheet_id = ? AND user_id = ?')
    .all(sheetId, userId) as LookupColumnRow[];

const readsColumn = (r: LookupColumnRow, column: string): boolean =>
  r.match_column === column || (lookupReturnColumns(r) ?? []).includes(column);

// Inside the rename's transaction, on the renamed column's sheet: lookup
// columns here (their own name, the column they read), and lookups looking in
// here (the column they match, the columns they return), and the looked-up
// column's source: the triggers compare the new key from now on, and its keys
// stay (the values didn't change).
export function renameLookupColumnRefs(sheetId: string, userId: string, oldName: string, newName: string): void {
  db.prepare(`UPDATE lookup_columns SET column_name = ?, updated_at = datetime('now')
    WHERE sheet_id = ? AND user_id = ? AND column_name = ?`).run(newName, sheetId, userId, oldName);
  db.prepare(`UPDATE lookup_columns SET source_column = ?, updated_at = datetime('now')
    WHERE sheet_id = ? AND user_id = ? AND source_column = ?`).run(newName, sheetId, userId, oldName);
  db.prepare(`UPDATE lookup_sources SET column_name = ?, path = ?
    WHERE sheet_id = ? AND user_id = ? AND column_name = ?`).run(newName, jsonPath(newName), sheetId, userId, oldName);
  const save = db.prepare(`UPDATE lookup_columns SET match_column = ?, return_columns = ?,
    updated_at = datetime('now') WHERE id = ?`);
  for (const r of lookingIn(sheetId, userId)) {
    if (!readsColumn(r, oldName)) continue;
    const returns = lookupReturnColumns(r);
    save.run(r.match_column === oldName ? newName : r.match_column,
      returns === null ? null : JSON.stringify(returns.map(c => (c === oldName ? newName : c))), r.id);
  }
}


function sheetName(sheetId: string, userId: string): string {
  return (db.prepare('SELECT name FROM sheets WHERE id = ? AND user_id = ?').pluck()
    .get(sheetId, userId) as string | undefined) ?? 'the other sheet';
}

// Lookups looking in this sheet that read a column no longer in it stop, and
// a source on such a column goes (its keys are deleted in slices).
function breakOnMissing(sheetId: string, userId: string, gone: (column: string) => boolean): void {
  const name = sheetName(sheetId, userId);
  const breakLookup = db.prepare(`UPDATE lookup_columns SET broken = ?, updated_at = datetime('now')
    WHERE id = ? AND broken IS NULL`);
  for (const r of lookingIn(sheetId, userId)) {
    const missing = [r.match_column, ...(lookupReturnColumns(r) ?? [])].find(gone);
    if (missing) breakLookup.run(`The column "${missing}" in "${name}" was deleted.`, r.id);
  }
  const sources = db.prepare('SELECT id, column_name FROM lookup_sources WHERE sheet_id = ? AND user_id = ?')
    .all(sheetId, userId) as Array<{ id: number; column_name: string }>;
  for (const s of sources) if (gone(s.column_name)) db.prepare('DELETE FROM lookup_sources WHERE id = ?').run(s.id);
}

// Inside the delete's transaction (before its rows are stripped): a lookup
// column's own record goes (deleting the column it reads keeps it, with its
// values, and its auto-run waits); lookups looking in here that read the
// column stop.
export function deleteLookupColumnRefs(sheetId: string, userId: string, column: string): void {
  db.prepare('DELETE FROM lookup_columns WHERE sheet_id = ? AND user_id = ? AND column_name = ?')
    .run(sheetId, userId, column);
  breakOnMissing(sheetId, userId, c => c === column);
}

function listedColumns(sheetId: string, userId: string): string[] {
  const order = db.prepare('SELECT column_order FROM sheets WHERE id = ? AND user_id = ?')
    .pluck().get(sheetId, userId) as string | null | undefined;
  try {
    const v = JSON.parse(order ?? '[]');
    return Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

// A CSV replace's last transaction (after the new column list is saved): a
// lookup column the file didn't bring back is gone, with its auto-run; lookups
// looking in this sheet that read a column it didn't bring back stop.
export function forgetUnlistedLookupColumns(sheetId: string, userId: string): void {
  const listed = listedColumns(sheetId, userId);
  const keep = JSON.stringify(listed);
  db.prepare(`DELETE FROM autorun_columns WHERE sheet_id = ? AND user_id = ? AND kind = 'lookup'
    AND status_column NOT IN (SELECT value FROM json_each(?))`).run(sheetId, userId, keep);
  db.prepare(`DELETE FROM lookup_columns WHERE sheet_id = ? AND user_id = ?
    AND column_name NOT IN (SELECT value FROM json_each(?))`).run(sheetId, userId, keep);
  const have = new Set(listed);
  breakOnMissing(sheetId, userId, c => !have.has(c));
}
