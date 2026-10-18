// A trash batch filled in slices by a journaled job: removing duplicates
// (dedupe-remove.ts) and a CSV import replacing the rows (csv-import.ts). It is
// opened 'moving' before the first row goes in, each slice moves its rows in
// the transaction that deletes them (lib/trash/move.ts), and the job's last
// transaction seals it 'kept'. A sheet runs one such job at a time (its busy
// lock), so a job a restart cut short finds its batch by sheet and kind, and
// goes on filling it. With Settings keeping deleted rows 0 days there is none.
import { db } from '../lib/db';
import { TRASH_SLICE_ROWS } from '../lib/constants';
import { runInCheckpointedSlices } from '../lib/slices';
import { removeRows, sealBatch } from '../lib/trash/move';
import { insertTrashItem, sheetFacts, trashKeeps } from '../lib/trash/store';

type SlicedHow = 'duplicates' | 'import';

// The batch still filling for this job.
export function movingBatch(sheetId: string, userId: string, how: SlicedHow): number | null {
  const id = db.prepare(`SELECT id FROM trash_items WHERE sheet_id = ? AND user_id = ? AND kind = 'rows' AND how = ?
    AND state = 'moving' ORDER BY id DESC LIMIT 1`).pluck().get(sheetId, userId, how) as number | undefined;
  return id ?? null;
}

// The job's batch: the one it left filling, or a new one (null when nothing is kept).
export function openSlicedBatch(sheetId: string, userId: string, how: SlicedHow): number | null {
  const open = movingBatch(sheetId, userId, how);
  if (open !== null) return open;
  const facts = sheetFacts(sheetId, userId);
  if (!facts || !trashKeeps(userId)) return null;
  return insertTrashItem({
    userId, kind: 'rows', how, tableId: facts.tableId, sheetId, columns: facts.columns, state: 'moving',
  });
}

// A batch that ended up empty (no row was removed) leaves the trash.
export function dropIfEmpty(itemId: number): boolean {
  return db.prepare("DELETE FROM trash_items WHERE id = ? AND row_count = 0 AND kind = 'rows'")
    .run(itemId).changes > 0;
}

// A CSV import replacing the rows: the sheet's rows with first <= row_index <
// end go to the job's batch (or for good, nothing kept), a slice at a time,
// then the batch is sealed. Their AI/HTTP results are the caller's to purge
// (all of the sheet's go). Returns the batch (null: none kept) and how many
// rows went.
export async function trashRowRange(
  sheetId: string, userId: string, first: number, end: number, how: SlicedHow,
): Promise<{ trashId: number | null; moved: number }> {
  const item = openSlicedBatch(sheetId, userId, how);
  const slice = db.prepare(`SELECT rowid FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index >= ?
    AND row_index < ? ORDER BY row_index LIMIT ?`).pluck();
  let moved = 0;
  await runInCheckpointedSlices(() => {
    const rowids = slice.all(sheetId, userId, first, end, TRASH_SLICE_ROWS) as number[];
    if (rowids.length === 0) return false;
    db.transaction(() => { moved += removeRows(sheetId, userId, { rowids }, item, false).count; })();
    return true;
  });
  if (item === null) return { trashId: null, moved };
  let kept = true;
  db.transaction(() => {
    kept = !dropIfEmpty(item);
    if (kept) sealBatch(item, sheetId, userId);
  })();
  return { trashId: kept ? item : null, moved };
}
