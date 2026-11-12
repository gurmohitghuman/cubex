// Where an unfinished transform_column pass's record (column-transform-passes.ts,
// migration 056) goes when its column, sheet or rows move, each in the
// transaction of the move:
// - a rename of its column carries it along (column-rename.ts);
// - its column sent to the trash takes it along, out of the column's name (a
//   column added under that name meanwhile has no pass), and its restore brings
//   it back under the name the column comes back as (trash-restore-column-finish
//   .ts); purged with the trash item (the foreign key), or deleted at once when
//   the column is deleted for good (column-delete.ts);
// - its sheet or table sent to the trash keeps it, and deleted for good drops it
//   (the foreign key);
// - rows moving under its cursor drop it, the trash's records included: a sort,
//   a replace, an import undone or duplicates removed drop every record of the
//   sheet (056's trigger on row_generation); rows restored from the trash away
//   from their old places, a record whose cursor one of them crosses
//   (lib/trash/restore-rows.ts);
// - a copy of the sheet's values gets a record of its own for each one whose
//   column it copies, with a new pass id, its cursor at the copy's last row that
//   came from before the original's (services/sheet-copy*.ts).
import { db } from '../lib/db';
import { newPassId, transformCursor } from './column-transform-passes';

const live = 'sheet_id = ? AND user_id = ? AND target_column = ? AND trash_id IS NULL';
const CURSOR_AFTER = /^\d+:(-?\d+):/;

export function renameTransformPasses(sheetId: string, userId: string, from: string, to: string): void {
  db.prepare(`UPDATE transform_passes SET target_column = ? WHERE ${live}`).run(to, sheetId, userId, from);
}

// In the column delete's transaction: into its trash item, or gone (trashId null: deleted for good).
export function trashTransformPasses(sheetId: string, userId: string, column: string, trashId: number | null): void {
  if (trashId === null) db.prepare(`DELETE FROM transform_passes WHERE ${live}`).run(sheetId, userId, column);
  else db.prepare(`UPDATE transform_passes SET trash_id = ? WHERE ${live}`).run(trashId, sheetId, userId, column);
}

// In a column restore's last transaction: its pass, under the name it comes back as. A record still
// under that name can't be a column's (no column had it): it goes.
export function restoreTransformPasses(itemId: number, sheetId: string, userId: string, name: string): void {
  if (!db.prepare('SELECT 1 FROM transform_passes WHERE trash_id = ?').get(itemId)) return;
  db.prepare(`DELETE FROM transform_passes WHERE ${live}`).run(sheetId, userId, name);
  db.prepare('UPDATE transform_passes SET target_column = ?, trash_id = NULL WHERE trash_id = ?').run(name, itemId);
}

// Rows restored from the trash away from their old places, in that restore's transaction
// (lib/trash/restore-rows.ts): a pass whose cursor one of them crosses (it had reached the row's old place,
// or the row lands where it had reached) would apply the operation to it twice, or skip it: it goes.
export function rowsMovedUnderPasses(sheetId: string, userId: string, moved: Array<{ from: number; to: number }>):
  void {
  if (moved.length === 0) return;
  const passes = db.prepare('SELECT pass_id, cursor FROM transform_passes WHERE sheet_id = ? AND user_id = ?')
    .all(sheetId, userId) as Array<{ pass_id: string; cursor: string }>;
  const drop = db.prepare('DELETE FROM transform_passes WHERE pass_id = ?');
  for (const p of passes) {
    const reached = Number(CURSOR_AFTER.exec(p.cursor)?.[1] ?? -1);
    if (moved.some(m => m.from <= reached || m.to <= reached)) drop.run(p.pass_id);
  }
}

interface Copied { target_column: string; started_as: string; call_key: string; rows_done: number; after: number }

// In a sheet copy's first transaction: a record for the copy for each open pass of the source into a column it
// copies, its cursor before the copy's first row (the copy's slices move it: copiedPassMapper).
export function copyTransformPasses(source: string, copy: string, userId: string, columns: string[]): void {
  const generation = db.prepare('SELECT row_generation FROM sheets WHERE id = ?').pluck().get(copy) as number;
  const passes = db.prepare(`SELECT target_column, started_as, call_key, rows_done FROM transform_passes
    WHERE sheet_id = ? AND user_id = ? AND trash_id IS NULL`).all(source, userId) as Copied[];
  const put = db.prepare(`INSERT INTO transform_passes (pass_id, sheet_id, user_id, target_column, started_as,
    call_key, cursor, rows_done) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const p of passes.filter(q => columns.includes(q.target_column))) {
    const id = newPassId();
    put.run(id, copy, userId, p.target_column, p.started_as, p.call_key,
      transformCursor(generation, -1, p.call_key, id), p.rows_done);
  }
}

// For a copy's slice, in its transaction: each copied row's row_index in the source and in the copy. A copied
// pass's cursor moves to the copy's last row whose source row its original had reached.
export function copiedPassMapper(source: string, copy: string, userId: string) {
  const read = db.prepare(`SELECT pass_id, target_column, call_key, cursor FROM transform_passes
    WHERE sheet_id = ? AND user_id = ? AND trash_id IS NULL`);
  const set = db.prepare('UPDATE transform_passes SET cursor = ? WHERE pass_id = ?');
  return (rows: Array<{ from: number; to: number }>): void => {
    const copies = read.all(copy, userId) as Array<{ pass_id: string; target_column: string; call_key: string;
      cursor: string }>;
    if (copies.length === 0 || rows.length === 0) return;
    const originals = new Map((read.all(source, userId) as Array<{ target_column: string; cursor: string }>)
      .map(o => [o.target_column, Number(CURSOR_AFTER.exec(o.cursor)?.[1] ?? -1)]));
    for (const c of copies) {
      const reached = originals.get(c.target_column);
      if (reached === undefined) continue;
      let last = -1;
      for (const r of rows) if (r.from <= reached) last = r.to;
      if (last < 0) continue;
      const [generation] = c.cursor.split(':');
      set.run(transformCursor(Number(generation), last, c.call_key, c.pass_id), c.pass_id);
    }
  };
}
