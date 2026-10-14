// Clean data columns' records (clean_columns, migration 024): reading them,
// and keeping them in step with column renames and deletes (services/
// column-rename.ts, column-delete.ts call these in their transactions). A
// record names columns by name, as auto-run does: deleting a clean column
// forgets its record; deleting its source keeps it, with the values already
// cleaned, and its auto-run waits until a column by that name is back.
import { db } from './db';

export interface CleanColumnRow {
  id: string; user_id: string; sheet_id: string; column_name: string; source_column: string;
  cleaner: string; options: string; fill_status: 'filling' | 'done' | 'failed'; fill_cursor: number;
  filled_rows: number; blanked_rows: number; error_message: string | null;
}

export function cleanColumnFor(sheetId: string, userId: string, column: string): CleanColumnRow | undefined {
  return db.prepare('SELECT * FROM clean_columns WHERE sheet_id = ? AND user_id = ? AND column_name = ?')
    .get(sheetId, userId, column) as CleanColumnRow | undefined;
}

export function loadCleanColumn(id: string): CleanColumnRow | undefined {
  return db.prepare('SELECT * FROM clean_columns WHERE id = ?').get(id) as CleanColumnRow | undefined;
}

export function sheetCleanColumns(sheetId: string, userId: string): CleanColumnRow[] {
  return db.prepare('SELECT * FROM clean_columns WHERE sheet_id = ? AND user_id = ? ORDER BY created_at')
    .all(sheetId, userId) as CleanColumnRow[];
}

// Whether cleaning `source` into `column` would close a loop: the source is
// itself cleaned, directly or down a chain, from `column`. Records count even
// for columns not in the sheet now (a deleted source keeps its record), so a
// column made later under that name can't close one either.
export function cleanLoopThrough(sheetId: string, userId: string, column: string, source: string): string | null {
  const sources = new Map(sheetCleanColumns(sheetId, userId).map(r => [r.column_name, r.source_column]));
  const chain = [source];
  for (let at: string | undefined = source; at !== undefined && chain.length <= sources.size + 1;) {
    if (at === column) return chain.join(' ← ');
    at = sources.get(at);
    if (at !== undefined) chain.push(at);
  }
  return null;
}

// Whether renaming a column would close a loop of clean columns: a record can
// name a source that's gone (deleted, its values kept), and a column renamed
// to that name would become the source of what it is cleaned from.
export function cleanRenameLoop(sheetId: string, userId: string, oldName: string, newName: string): string | null {
  const to = (c: string) => (c === oldName ? newName : c);
  const records = sheetCleanColumns(sheetId, userId).map(r => [to(r.column_name), to(r.source_column)] as const);
  const sources = new Map(records);
  for (const [column] of records) {
    let at = sources.get(column);
    for (let steps = 0; at !== undefined && steps <= records.length; steps++) {
      if (at === column) return column;
      at = sources.get(at);
    }
  }
  return null;
}

// Inside the rename's transaction.
export function renameCleanColumnRefs(sheetId: string, userId: string, oldName: string, newName: string): void {
  db.prepare(`UPDATE clean_columns SET column_name = ?, updated_at = datetime('now')
    WHERE sheet_id = ? AND user_id = ? AND column_name = ?`).run(newName, sheetId, userId, oldName);
  db.prepare(`UPDATE clean_columns SET source_column = ?, updated_at = datetime('now')
    WHERE sheet_id = ? AND user_id = ? AND source_column = ?`).run(newName, sheetId, userId, oldName);
}

// A CSV replace's last transaction (after the new column list is saved): a
// clean column the file didn't bring back is gone, so its record and its
// auto-run go too. Kept, a column made later under that name would be taken
// over and filled from the old source.
export function forgetUnlistedCleanColumns(sheetId: string, userId: string): void {
  const order = db.prepare('SELECT column_order FROM sheets WHERE id = ? AND user_id = ?')
    .pluck().get(sheetId, userId) as string | null | undefined;
  let listed: unknown = [];
  try { listed = JSON.parse(order ?? '[]'); } catch { /* none listed */ }
  const keep = JSON.stringify(Array.isArray(listed) ? listed : []);
  db.prepare(`DELETE FROM autorun_columns WHERE sheet_id = ? AND user_id = ? AND kind = 'clean'
    AND status_column NOT IN (SELECT value FROM json_each(?))`).run(sheetId, userId, keep);
  db.prepare(`DELETE FROM clean_columns WHERE sheet_id = ? AND user_id = ?
    AND column_name NOT IN (SELECT value FROM json_each(?))`).run(sheetId, userId, keep);
}

// Inside the delete's transaction (its auto-run entry goes with
// deleteAutorunColumnRefs, which pauses the ones that read the column).
export function deleteCleanColumnRefs(sheetId: string, userId: string, column: string): void {
  db.prepare('DELETE FROM clean_columns WHERE sheet_id = ? AND user_id = ? AND column_name = ?')
    .run(sheetId, userId, column);
}
