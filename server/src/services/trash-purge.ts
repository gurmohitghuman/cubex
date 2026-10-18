// Gone for good, a slice at a time, never holding the server: what has been in
// the trash longer than Settings keeps it, and what the Trash page deletes
// now. The sweep runs every TRASH_SWEEP_MS, after boot, and when something is
// deleted while Settings keeps 0 days. An item being purged is 'purging', so a
// restart goes on with it and a restore can't start on it meanwhile.
//
// A batch of rows: its trash_rows, then the item. A sheet: lookups that look
// in it learn it is gone and its looked-up keys go (lib/trash/lookups.ts), then
// the row batches of it still in the trash, its rows, its runs' results and
// undo journals, its auto-run queue, list provenance and webhook deliveries,
// each in slices; then the sheet itself in one small transaction (the rest
// cascades). A table: each of its sheets, then the table. The sweep also
// prunes the change log and old undo journals (services/run-undo-prune.ts).
import { db } from '../lib/db';
import { HEAVY_SLICE_ROWS, TRASH_PURGE_BATCH_ROWS, TRASH_SLICE_ROWS, TRASH_SWEEP_MS } from '../lib/constants';
import { runInCheckpointedSlices } from '../lib/slices';
import { sheetBusyWith } from '../lib/sheet-busy';
import { purgeSheetResults } from '../lib/import-undo';
import { autorunDropPending } from '../lib/autorun-mark';
import { lookupsLoseSheet } from '../lib/trash/lookups';
import type { TrashItem } from '../lib/trash/store';
import { pruneChangeLog } from './sheet-history';
import { dropSheetUndos, pruneRunUndos } from './run-undo-prune';

let sweeping = false;
let again = false;
let timer: ReturnType<typeof setInterval> | null = null;

export function startTrashLoop(): void {
  if (timer) return;
  timer = setInterval(kickTrashPurge, TRASH_SWEEP_MS);
  timer.unref?.();
  kickTrashPurge();
}

// Look now (one sweep at a time; a kick during one makes it look again after).
export function kickTrashPurge(): void {
  if (sweeping) { again = true; return; }
  sweeping = true;
  void (async () => {
    try {
      do {
        again = false;
        await purgeDue();
        await pruneChangeLog();
        await pruneRunUndos();
      } while (again);
    } catch (error) {
      console.error('Emptying the trash failed (tried again next sweep):', error);
    } finally { sweeping = false; }
  })();
}

// The Trash page's "Delete for good": marked now, gone in the background.
// Returns the items marked (one being restored, or already gone, isn't).
export function purgeTrashItems(userId: string, ids: number[]): number[] {
  const marked: number[] = [];
  const mark = db.prepare(`UPDATE trash_items SET state = 'purging' WHERE id = ? AND user_id = ?
    AND state IN ('kept', 'purging')`);
  db.transaction(() => { for (const id of ids) if (mark.run(id, userId).changes > 0) marked.push(id); })();
  if (marked.length > 0) kickTrashPurge();
  return marked;
}

async function purgeDue(): Promise<void> {
  const due = db.prepare(`SELECT i.* FROM trash_items i LEFT JOIN settings st ON st.user_id = i.user_id
    WHERE i.state = 'purging' OR (i.state = 'kept'
      AND i.deleted_at <= datetime('now', '-' || COALESCE(st.trash_days, 30) || ' days'))
    ORDER BY i.id`).all() as TrashItem[];
  for (const item of due) {
    const claimed = db.prepare(`UPDATE trash_items SET state = 'purging' WHERE id = ? AND state IN ('kept', 'purging')`)
      .run(item.id).changes > 0;
    if (!claimed) continue;
    if (item.kind === 'rows') await purgeBatch(item.id);
    else if (item.kind === 'sheet' && item.sheet_id) await purgeSheet(item.sheet_id, item.user_id, item.id);
    else if (item.kind === 'table') await purgeTable(item.table_id, item.user_id, item.id);
  }
}

// A batch's rows in their order (cheap: the primary key's order), then the item.
async function purgeBatch(itemId: number): Promise<void> {
  const slice = db.prepare(`DELETE FROM trash_rows WHERE rowid IN (SELECT rowid FROM trash_rows WHERE item_id = ?
    ORDER BY seq LIMIT ?)`);
  await runInCheckpointedSlices(() => slice.run(itemId, TRASH_PURGE_BATCH_ROWS).changes > 0);
  db.prepare('DELETE FROM trash_items WHERE id = ?').run(itemId);
}

// Deletes `sql` (a DELETE taking its slice size last) until nothing is left,
// with a PASSIVE checkpoint after each slice (lib/constants-trash.ts).
async function deleteInSlices(sql: string, params: unknown[], size: number): Promise<void> {
  const stmt = db.prepare(sql);
  await runInCheckpointedSlices(() => stmt.run(...params, size).changes > 0);
}

// False when something still finishing on it (a restart's job) holds it: next sweep.
async function purgeSheet(sheetId: string, userId: string, itemId: number | null): Promise<boolean> {
  if (sheetBusyWith(sheetId)) return false;
  const name = db.prepare('SELECT name FROM sheets WHERE id = ?').pluck().get(sheetId) as string | undefined;
  if (name !== undefined) db.transaction(() => lookupsLoseSheet(sheetId, name))();
  for (const batch of db.prepare(`SELECT id FROM trash_items WHERE sheet_id = ? AND kind = 'rows'`).pluck()
    .all(sheetId) as number[]) {
    db.prepare(`UPDATE trash_items SET state = 'purging' WHERE id = ?`).run(batch);
    await purgeBatch(batch);
  }
  await deleteInSlices(`DELETE FROM rows WHERE rowid IN (SELECT rowid FROM rows WHERE sheet_id = ? AND user_id = ?
    LIMIT ?)`, [sheetId, userId], TRASH_SLICE_ROWS);
  await purgeSheetResults(sheetId, userId);
  await dropSheetUndos(sheetId);
  await autorunDropPending(sheetId, userId);
  await deleteInSlices(`DELETE FROM enrichment_list_rows WHERE rowid IN (SELECT rowid FROM enrichment_list_rows
    WHERE dest_sheet_id = ? LIMIT ?)`, [sheetId], HEAVY_SLICE_ROWS);
  await deleteInSlices(`DELETE FROM webhook_deliveries WHERE rowid IN (SELECT rowid FROM webhook_deliveries
    WHERE source_id IN (SELECT id FROM webhook_sources WHERE sheet_id = ?) LIMIT ?)`, [sheetId], HEAVY_SLICE_ROWS);
  await deleteInSlices(`DELETE FROM lookup_dirty WHERE (sheet_id, rid) IN (SELECT sheet_id, rid FROM lookup_dirty
    WHERE sheet_id = ? LIMIT ?)`, [sheetId], HEAVY_SLICE_ROWS);
  db.transaction(() => {
    db.prepare('DELETE FROM sheets WHERE id = ? AND user_id = ?').run(sheetId, userId);
    if (itemId !== null) db.prepare('DELETE FROM trash_items WHERE id = ?').run(itemId);
  })();
  return true;
}

async function purgeTable(tableId: string, userId: string, itemId: number): Promise<void> {
  const sheets = db.prepare('SELECT id FROM sheets WHERE table_id = ? AND user_id = ?').pluck()
    .all(tableId, userId) as string[];
  for (const id of sheets) {
    // A sheet of it deleted on its own earlier goes too, and its item with it.
    if (!(await purgeSheet(id, userId, null))) return;
    db.prepare(`DELETE FROM trash_items WHERE sheet_id = ? AND kind = 'sheet'`).run(id);
  }
  db.transaction(() => {
    db.prepare('DELETE FROM tables WHERE id = ? AND user_id = ?').run(tableId, userId);
    db.prepare('DELETE FROM trash_items WHERE id = ?').run(itemId);
  })();
}
