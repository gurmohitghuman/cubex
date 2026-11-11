// A deleted column's cells going into its trash item (migration 054), by the delete's own strip
// (lib/column-purge.ts purgeColumnKey): column_purges.trash_id names the item, and each slice copies the
// cells of its rows that hold a value into trash_rows ({"<name>": value}, the row's stable id and place)
// and removes them from the rows, in ONE transaction. A restart cuts it between slices at worst: the boot
// resume that finishes a strip (resumeColumnPurges) goes on with the rows still holding the cell. The last
// slice's transaction seals the item 'kept' and forgets the strip.
import { db } from '../db';

// The item the strip of `name` fills, while it is still filling (null: the cells just go).
export function purgeTrashItem(sheetId: string, name: string): number | null {
  return (db.prepare(`SELECT i.id FROM column_purges p JOIN trash_items i ON i.id = p.trash_id
    WHERE p.sheet_id = ? AND p.column_name = ? AND i.kind = 'column' AND i.state = 'moving'`).pluck()
    .get(sheetId, name) as number | undefined) ?? null;
}

// Inside the slice's transaction, before the strip removes the cells: those of the slice's rows (`idsJson`,
// their rowids) holding a value go into the item, after its last seq, and its counts grow.
export function copyCellsToItem(itemId: number, sheetId: string, userId: string, name: string, path: string,
  idsJson: string): void {
  const after = db.prepare('SELECT seq_high FROM trash_items WHERE id = ?').pluck().get(itemId) as number;
  const added = db.prepare(`INSERT INTO trash_rows (item_id, seq, row_index, row_id, data)
    SELECT ?, ? + ROW_NUMBER() OVER (ORDER BY rowid), row_index, id, json_object(?, data -> ?) FROM rows
    WHERE rowid IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?
      AND IFNULL(json_extract(data, ?), '') != ''`)
    .run(itemId, after, name, path, idsJson, sheetId, userId, path).changes;
  if (added === 0) return;
  const bytes = db.prepare(`SELECT IFNULL(SUM(length(CAST(data AS BLOB))), 0) FROM trash_rows
    WHERE item_id = ? AND seq > ?`).pluck().get(itemId, after) as number;
  db.prepare(`UPDATE trash_items SET row_count = row_count + ?, bytes = bytes + ?, seq_high = ? WHERE id = ?`)
    .run(added, bytes, after + added, itemId);
}

// After the last slice, in the transaction that forgets the strip: every cell is in, the item is kept.
export function sealColumnItem(itemId: number): void {
  db.prepare(`UPDATE trash_items SET state = 'kept' WHERE id = ? AND state = 'moving'`).run(itemId);
}
