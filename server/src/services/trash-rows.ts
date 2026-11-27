// Rows deleted in ONE transaction: the grid's delete (at most 10,000 rows a
// call), change_rows' delete over REST and MCP (1,000), and transfer_rows moving rows
// out (10,000). They go into one trash batch (lib/trash/move.ts), or are gone
// at once when Settings keeps deleted rows 0 days. The grid's delete and
// delete_rows on rows too big for one transaction go in slices with the sheet
// held, into the same kind of batch (trash-rows-sliced.ts). Bigger removals run
// in slices with a journal: removing duplicates (dedupe-remove.ts) and a CSV
// import replacing the rows (csv-import.ts) use trash-batch.ts.
import { db } from '../lib/db';
import { TRASH_GROUP_MS } from '../lib/constants';
import { removeRows, sealBatch, type RowPick } from '../lib/trash/move';
import { insertTrashItem, sheetFacts, trashKeeps, type TrashHow } from '../lib/trash/store';
import { countOf, logSheetChange, rewriteSheetChange } from '../lib/change-log';

export interface TrashedRows { count: number; indexes: number[]; trashId: number | null }

// The batch a grid delete sent in several calls goes on in: the first call's,
// while it is recent and still whole in the trash.
function batchToContinue(id: number, sheetId: string, userId: string, how: TrashHow): number | null {
  const since = new Date(Date.now() - TRASH_GROUP_MS).toISOString().replace('T', ' ').slice(0, 19);
  const row = db.prepare(`SELECT id FROM trash_items WHERE id = ? AND user_id = ? AND sheet_id = ? AND kind = 'rows'
    AND how = ? AND state = 'kept' AND deleted_at >= ?`).get(id, userId, sheetId, how, since) as
    { id: number } | undefined;
  return row?.id ?? null;
}

type DeleteHow = 'grid' | 'api' | 'transfer';

// Call inside the transaction that deletes (it checked the sheet, runs and
// fences). `continueId`: a grid delete's earlier call (its answer's trash id).
export function deleteRowsToTrash(
  sheetId: string, userId: string, how: DeleteHow, pick: RowPick, continueId?: number,
): TrashedRows {
  const batch = openRowsBatch(sheetId, userId, how, continueId);
  const removed = removeRows(sheetId, userId, pick, batch?.item ?? null);
  return { ...removed, trashId: closeRowsBatch(sheetId, userId, how, batch, removed.count) };
}

// The batch a delete's rows go into: a grid delete's earlier call's (`earlier`), or a new one, 'moving' until
// closed. Null when Settings keeps deleted rows 0 days.
export interface RowsBatch { item: number; earlier: boolean }
export function openRowsBatch(sheetId: string, userId: string, how: DeleteHow, continueId?: number): RowsBatch | null {
  const facts = sheetFacts(sheetId, userId);
  if (!facts || !trashKeeps(userId)) return null;
  const earlier = continueId === undefined ? null : batchToContinue(continueId, sheetId, userId, how);
  if (earlier === null) {
    return { item: insertTrashItem({
      userId, kind: 'rows', how, tableId: facts.tableId, sheetId, columns: facts.columns, state: 'moving',
    }), earlier: false };
  }
  // A later call keeps every column the batch has seen (one added meanwhile too).
  widenColumns(earlier, facts.columns);
  return { item: earlier, earlier: true };
}

// Once the delete's `count` rows are in: the batch sealed and the History line written (a grid delete's later
// call: its first call's line counts every row), or a new batch nothing went into dropped. Returns the batch.
export function closeRowsBatch(
  sheetId: string, userId: string, how: DeleteHow, batch: RowsBatch | null, count: number,
): number | null {
  if (batch === null) {
    if (count > 0 && how !== 'transfer') logDeleted(sheetId, userId, count, null);
    return null;
  }
  if (count === 0 && !batch.earlier) {
    db.prepare('DELETE FROM trash_items WHERE id = ?').run(batch.item);
    return null;
  }
  sealBatch(batch.item, sheetId, userId);
  if (how !== 'transfer') {
    if (!batch.earlier) logDeleted(sheetId, userId, count, batch.item);
    else relogDeleted(sheetId, batch.item);
  }
  return batch.item;
}

// A batch's History line, for one a restart left moving: its line rewritten to count every row, or a new one.
export function logRowsBatch(sheetId: string, userId: string, trashId: number): void {
  if (!relogDeleted(sheetId, trashId)) {
    const rows = db.prepare('SELECT row_count FROM trash_items WHERE id = ?').pluck().get(trashId) as number;
    logDeleted(sheetId, userId, rows, trashId);
  }
}

// A batch that goes on keeps every column its rows had (one added meanwhile too).
export function widenColumns(itemId: number, columns: string[]): void {
  const raw = db.prepare('SELECT columns FROM trash_items WHERE id = ?').pluck().get(itemId) as string;
  let have: string[] = [];
  try { have = JSON.parse(raw); } catch { /* the sheet's list stands */ }
  const all = [...have, ...columns.filter(c => !have.includes(c))];
  if (all.length !== have.length) {
    db.prepare('UPDATE trash_items SET columns = ? WHERE id = ?').run(JSON.stringify(all), itemId);
  }
}

function logDeleted(sheetId: string, userId: string, count: number, trashId: number | null): void {
  logSheetChange(sheetId, userId, 'rows_deleted', `Deleted ${countOf(count, 'row')}`,
    { detail: { rows: count, trash_id: trashId } });
}

// A grid delete's later call: the line of its first call counts every row. False when there is none.
function relogDeleted(sheetId: string, trashId: number): boolean {
  const line = db.prepare(`SELECT id FROM sheet_changes WHERE sheet_id = ? AND action = 'rows_deleted'
    AND json_extract(detail, '$.trash_id') = ? ORDER BY id DESC LIMIT 1`).pluck().get(sheetId, trashId) as
    number | undefined;
  const rows = db.prepare('SELECT row_count FROM trash_items WHERE id = ?').pluck().get(trashId) as number;
  if (line === undefined) return false;
  rewriteSheetChange(line, `Deleted ${countOf(rows, 'row')}`, { rows, trash_id: trashId });
  return true;
}
