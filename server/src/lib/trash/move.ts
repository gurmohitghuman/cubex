// Rows leaving a sheet: into a trash batch (trash_rows, migration 036), or
// gone at once when Settings keeps deleted rows 0 days. Called inside the
// transaction that deletes them, so a crash never leaves a row in both places
// or in neither. Their AI/HTTP results are purged as on any delete (results
// are stored by position: lib/sql-rows.ts purgeResultsForRows); a batch keeps
// the cells, which hold what the runs wrote.
import { db } from '../db';
import { purgeResultsForRows } from '../sql-helpers';

// The rows, by SQLite rowid, stable id or position in the sheet.
export type RowPick = { rowids: number[] } | { ids: string[] } | { indexes: number[] };

function pickSql(pick: RowPick): { where: string; list: string } {
  if ('rowids' in pick) {
    return { where: 'rowid IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?',
      list: JSON.stringify(pick.rowids) };
  }
  if ('ids' in pick) {
    return { where: 'id IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?',
      list: JSON.stringify(pick.ids) };
  }
  return { where: 'row_index IN (SELECT value FROM json_each(?)) AND sheet_id = ? AND user_id = ?',
    list: JSON.stringify(pick.indexes) };
}

export interface Removed { count: number; indexes: number[] }

// Deletes the picked rows of the sheet. With a batch (`itemId`), they go into
// it first, after its rows, in row order. purgeResults: false when the caller
// purges every result of the sheet anyway (a CSV replace).
export function removeRows(
  sheetId: string, userId: string, pick: RowPick, itemId: number | null, purgeResults = true,
): Removed {
  const { where, list } = pickSql(pick);
  const indexes = db.prepare(`SELECT row_index FROM rows WHERE ${where} ORDER BY row_index`).pluck()
    .all(list, sheetId, userId) as number[];
  if (indexes.length === 0) return { count: 0, indexes };
  if (itemId !== null) {
    const after = (db.prepare('SELECT MAX(seq) FROM trash_rows WHERE item_id = ?').pluck().get(itemId) as
      number | null) ?? 0;
    db.prepare(`INSERT INTO trash_rows (item_id, seq, row_index, row_id, data)
      SELECT ?, ? + ROW_NUMBER() OVER (ORDER BY row_index), row_index, id, data FROM rows WHERE ${where}`)
      .run(itemId, after, list, sheetId, userId);
    const added = db.prepare(`SELECT COUNT(*) AS n, IFNULL(SUM(length(CAST(data AS BLOB))), 0) AS bytes,
      MAX(row_index) AS top FROM trash_rows WHERE item_id = ? AND seq > ?`)
      .get(itemId, after) as { n: number; bytes: number; top: number };
    db.prepare(`UPDATE trash_items SET row_count = row_count + ?, bytes = bytes + ?,
      top_index = MAX(IFNULL(top_index, ?), ?) WHERE id = ?`).run(added.n, added.bytes, added.top, added.top, itemId);
  }
  db.prepare(`DELETE FROM rows WHERE ${where}`).run(list, sheetId, userId);
  if (purgeResults) purgeResultsForRows(sheetId, userId, indexes);
  return { count: indexes.length, indexes };
}

// Once a batch's rows are all in (the deleting transaction, or a sliced job's
// last one): the sheet's row_generation then, which a restore compares to
// tell whether the rows' old places still mean anything.
export function sealBatch(itemId: number, sheetId: string, userId: string): void {
  db.prepare(`UPDATE trash_items SET state = 'kept', row_generation =
      (SELECT row_generation FROM sheets WHERE id = ? AND user_id = ?) WHERE id = ?`).run(sheetId, userId, itemId);
}
