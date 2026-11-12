// Putting a deleted column back (services/trash-restore-column.ts runs it, with the sheet busy): the name it
// gets, its cells a slice at a time, and its place. Cells go back while the column isn't listed yet (the
// sheet stays busy, so nothing else reads or names it); the last transaction lists it, so a restore that
// stops before its first slice leaves the sheet as it was. Cells whose rows were gone, or whose rows hold a
// value there now, stay in the item; a later restore of it (its leftovers) puts them into that column once
// their rows are back and empty there. A restore never deletes a trashed value for good.
import { db } from '../db';
import { MAX_COLUMN_NAME_LENGTH } from '../constants-columns';
import { appendColumnsToOrder, getSheetColumns, jsonPath } from '../sql-helpers';
import { stripInvisibleNameChars } from '../name-safety';
import { pendingPurges } from '../column-purge';
import { findColumnNameCollision } from '../column-names';
import { markDerivedInputs } from '../autorun-mark';
import type { VersionColumn } from '../setup-versions/spec';
import type { DroppedRef } from './column-refs';
import type { TrashItem } from './store';

export function columnSetupOf(item: TrashItem): VersionColumn {
  const name = item.column_name ?? '';
  try {
    const v = JSON.parse(item.column_setup ?? 'null') as VersionColumn | null;
    if (v && typeof v === 'object') return { name, description: v.description ?? null, fill: v.fill ?? null,
      autoRun: v.autoRun ?? null };
  } catch { /* below: a plain column */ }
  return { name, description: null, fill: null, autoRun: null };
}

export function droppedRefsOf(item: TrashItem): DroppedRef[] {
  try {
    const v = JSON.parse(item.column_dropped ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

// "<old><tail>", the old name cut to fit a column name when it must be (as a restored sheet's name is,
// trash-restore-sheet.ts): never through a character made of two halves, nor leaving a joiner without its emoji.
function withTail(old: string, tail: string): string {
  if (old.length + tail.length <= MAX_COLUMN_NAME_LENGTH) return `${old}${tail}`;
  const room = Math.max(1, MAX_COLUMN_NAME_LENGTH - tail.length);
  const cut = /[\uD800-\uDBFF]/.test(old[room - 1]) ? room - 1 : room;
  return `${stripInvisibleNameChars(old.slice(0, cut)).trimEnd()}${tail}`;
}

// The old name when no column has it (in any case, or as the same /name), else "<name> (restored)",
// "(restored 2)"…, cut to fit. A name still being stripped from the rows counts as taken.
export function freeColumnName(sheetId: string, userId: string, old: string): string {
  const taken = [...getSheetColumns(sheetId, userId, false), ...pendingPurges(sheetId)];
  for (let i = 0; ; i++) {
    const name = i === 0 ? old : withTail(old, i === 1 ? ' (restored)' : ` (restored ${i})`);
    if (!findColumnNameCollision(name, taken)) return name;
  }
}

interface Cell { seq: number; row_id: string; value: string; size: number }

// One transaction: up to `limit` of the item's cells after its cursor (in seq order) go back to their rows
// under `name`, found by stable id. A row holding a value there now keeps it (kept), and a row gone since is
// skipped: either cell stays in the item, for a later restore. The counts say which.
// Clean, formula and lookup columns reading `name` work the rows written out again (quietly: no paid run).
// Returns how many cells it went through.
export function restoreCellsSlice(itemId: number, sheetId: string, userId: string, name: string,
  limit: number): number {
  let n = 0;
  db.transaction(() => {
    const item = db.prepare('SELECT column_name, restore_cursor FROM trash_items WHERE id = ?').get(itemId) as
      { column_name: string; restore_cursor: number } | undefined;
    if (!item) return;
    const cells = db.prepare(`SELECT seq, row_id, data -> ? AS value, length(CAST(data AS BLOB)) AS size
      FROM trash_rows WHERE item_id = ? AND seq > ? ORDER BY seq LIMIT ?`)
      .all(jsonPath(item.column_name), itemId, item.restore_cursor, limit) as Cell[];
    if (cells.length === 0) return;
    const path = jsonPath(name);
    const rows = db.prepare(`SELECT rowid AS rid, id, IFNULL(json_extract(data, ?), '') != '' AS held FROM rows
      WHERE id IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?`)
      .all(path, JSON.stringify(cells.map(c => c.row_id)), sheetId, userId) as
      Array<{ rid: number; id: string; held: number }>;
    const byId = new Map(rows.map(r => [r.id, r]));
    const write = db.prepare(`UPDATE rows SET data = json_set(data, ?, json(?)), updated_at = datetime('now')
      WHERE rowid = ?`);
    const written: number[] = [];
    const done: number[] = [];
    let skipped = 0, kept = 0, bytes = 0;
    for (const c of cells) {
      const row = byId.get(c.row_id);
      if (!row) { skipped++; continue; }
      if (row.held) { kept++; continue; }
      done.push(c.seq);
      bytes += c.size;
      write.run(path, c.value, row.rid);
      written.push(row.rid);
    }
    if (written.length) markDerivedInputs(sheetId, userId, [name], { rowids: written });
    if (done.length) {
      db.prepare(`DELETE FROM trash_rows WHERE item_id = ? AND seq IN (SELECT value FROM json_each(?))`)
        .run(itemId, JSON.stringify(done));
    }
    db.prepare(`UPDATE trash_items SET restored = restored + ?, restore_skipped = restore_skipped + ?,
      restore_kept = restore_kept + ?, row_count = MAX(0, row_count - ?), bytes = MAX(0, bytes - ?),
      restore_cursor = ? WHERE id = ?`)
      .run(written.length, skipped, kept, done.length, bytes, cells[cells.length - 1].seq, itemId);
    n = cells.length;
  }).immediate();
  return n;
}

// The column listed again (through the registry: lib/sheet-columns.ts), then moved to its old place, or last
// when the sheet has fewer columns now. Returns its index.
export function listAt(sheetId: string, userId: string, name: string, position: number | null): number {
  appendColumnsToOrder(sheetId, userId, [name]);
  const columns = getSheetColumns(sheetId, userId, false).filter(c => c !== name);
  const at = Math.max(0, Math.min(position ?? columns.length, columns.length));
  columns.splice(at, 0, name);
  db.prepare('UPDATE sheets SET column_order = ? WHERE id = ? AND user_id = ?')
    .run(JSON.stringify(columns), sheetId, userId);
  return at;
}
