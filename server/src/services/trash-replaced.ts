// Rows a list job's rerun replaces: the rows one source row added to the other
// sheet last time. They go into that sheet's rerun batch in the trash (one per
// sheet a day, like auto-dedupe's), or are gone at once when Settings keeps
// deleted rows 0 days. History gets one line for a run of them, not one per
// source row: the sheet's newest line, when it is today's line for the same
// batch, counts the new ones too.
import { db } from '../lib/db';
import { removeRows, sealBatch } from '../lib/trash/move';
import { insertTrashItem, sheetFacts, todaysBatch, trashKeeps } from '../lib/trash/store';
import { countOf, logSheetChange, rewriteSheetChange } from '../lib/change-log';
import { widenColumns } from './trash-rows';

const summary = (n: number): string => `A rerun replaced ${countOf(n, 'row')} it had added before`;

// Call inside the transaction that adds the new rows, with the rows still in
// the sheet. Returns how many went.
export function trashReplacedRows(sheetId: string, userId: string, ids: string[]): number {
  if (ids.length === 0) return 0;
  const facts = sheetFacts(sheetId, userId);
  if (!facts || !trashKeeps(userId)) {
    const gone = removeRows(sheetId, userId, { ids }, null);
    if (gone.count > 0) logReplaced(sheetId, userId, gone.count, null);
    return gone.count;
  }
  const earlier = todaysBatch(sheetId, userId, 'rerun', facts.generation);
  let item = earlier;
  if (item === null) {
    item = insertTrashItem({
      userId, kind: 'rows', how: 'rerun', tableId: facts.tableId, sheetId, columns: facts.columns,
    });
    sealBatch(item, sheetId, userId);
  } else {
    widenColumns(item, facts.columns);
  }
  const removed = removeRows(sheetId, userId, { ids }, item);
  if (removed.count === 0) {
    if (earlier === null) db.prepare('DELETE FROM trash_items WHERE id = ?').run(item);
    return 0;
  }
  // Kept for the days Settings sets from its last row.
  db.prepare("UPDATE trash_items SET deleted_at = datetime('now') WHERE id = ?").run(item);
  logReplaced(sheetId, userId, removed.count, item);
  return removed.count;
}

// Counts what this call replaced, so a restore of part of the batch meanwhile
// never makes the line say fewer than went.
function logReplaced(sheetId: string, userId: string, count: number, trashId: number | null): void {
  const last = db.prepare(`SELECT id, action, detail, date(at) = date('now') AS today FROM sheet_changes
    WHERE sheet_id = ? ORDER BY id DESC LIMIT 1`).get(sheetId) as
    { id: number; action: string; detail: string | null; today: number } | undefined;
  let detail: { how?: unknown; rows?: unknown; trash_id?: unknown } | null = null;
  try { detail = last?.detail ? JSON.parse(last.detail) : null; } catch { /* a new line */ }
  if (last && last.today && last.action === 'rows_deleted' && detail?.how === 'rerun'
    && detail.trash_id === trashId && typeof detail.rows === 'number') {
    const rows = detail.rows + count;
    rewriteSheetChange(last.id, summary(rows), { rows, trash_id: trashId, how: 'rerun' });
  } else {
    logSheetChange(sheetId, userId, 'rows_deleted', summary(count),
      { detail: { rows: count, trash_id: trashId, how: 'rerun' } });
  }
}
