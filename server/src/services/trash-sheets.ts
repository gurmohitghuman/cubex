// Deleting a sheet or a table puts it in the trash whole: it stays where it
// is, with its rows, columns, runs, views and webhook, hidden by trash_id
// (migration 036), and comes back as it was. Hidden means every read of a
// sheet or table passes over it (verifySheetOwnership and the lists), and
// nothing works on it any more: its runs and the list runs adding rows to it
// are cancelled, its setups stop, its webhook answers 404, auto-run passes it
// by, and lookups in other sheets that look in it stop with a message until
// it is back. trash-purge.ts deletes it for good once it has been kept long
// enough (at once when Settings keeps 0 days), a slice at a time.
import { db } from '../lib/db';
import { countRows } from '../lib/sql-helpers';
import { busyMessage, sheetBusyWith } from '../lib/sheet-busy';
import { dropBucketsForSheets } from '../lib/webhook-bucket';
import { insertTrashItem, trashKeeps } from '../lib/trash/store';
import { logSheetChange } from '../lib/change-log';
import { trashedLookupMessage } from '../lib/trash/lookups';
import { clearRunPlaceholders } from '../lib/run-placeholders';
import { abortListRunsInto, clearListRunCells } from './run-control';
import { resultsNotAdded, type ResultsNotAdded } from './enrich-list-guard';
import { kickTrashPurge } from './trash-purge';
import { sourcesGone } from './enrich-list-source';
import { failedCell } from '../lib/enrich-cells';

export type TrashFail = { fail: 'not_found' | 'conflict' | 'bad_request'; message: string };

interface Retired { runs: Array<['ai' | 'http', string]>; listRuns: string[]; sources: string[] }

// Inside the deleting transaction: everything that could still work on the
// sheets stops. Their runs are cancelled as a person's cancel is, so their "⏳"
// cells clear (the sheet may come back). Returns those runs and the list runs
// into them (clear their cells after the commit), and the webhook sources
// (drop their rate buckets after).
function retireSheets(sheetIds: string[], userId: string): Retired {
  const ids = JSON.stringify(sheetIds);
  const sources = db.prepare(`SELECT id FROM webhook_sources WHERE sheet_id IN (SELECT value FROM json_each(?))
    AND user_id = ?`).pluck().all(ids, userId) as string[];
  const runs: Retired['runs'] = [];
  for (const kind of ['ai', 'http'] as const) {
    const table = kind === 'ai' ? 'ai_runs' : 'http_runs';
    const active = db.prepare(`SELECT id FROM ${table} WHERE sheet_id IN (SELECT value FROM json_each(?))
      AND user_id = ? AND status IN ('pending', 'running', 'paused')`).pluck().all(ids, userId) as string[];
    db.prepare(`UPDATE ${table} SET status = 'cancelled', placeholder_work = 'clearing', updated_at = datetime('now')
      WHERE id IN (SELECT value FROM json_each(?))`).run(JSON.stringify(active));
    for (const id of active) runs.push([kind, id]);
  }
  // List results on their way into these sheets: their source rows say they
  // weren't added (destsGone), and the journal rows go, as with the sheet.
  const listRuns = abortListRunsInto(sheetIds);
  // Results their own list columns bought that aren't rows yet go too (the
  // delete's answer says so: resultsNotAdded), their ➕ cells saying so.
  sourcesGone(sheetIds, failedCell('Rows not added: this sheet was deleted.'));
  db.prepare(`DELETE FROM enrichment_list_items WHERE (source_sheet_id IN (SELECT value FROM json_each(?))
    OR dest_sheet_id IN (SELECT value FROM json_each(?))) AND user_id = ?`).run(ids, ids, userId);
  db.prepare(`UPDATE setup_runs SET status = 'cancelled', error_message = 'Its sheet was deleted.',
      updated_at = datetime('now')
    WHERE sheet_id IN (SELECT value FROM json_each(?)) AND user_id = ? AND status IN ('running', 'paused')`)
    .run(ids, userId);
  for (const s of db.prepare('SELECT id, name FROM sheets WHERE id IN (SELECT value FROM json_each(?))')
    .all(ids) as Array<{ id: string; name: string }>) {
    db.prepare(`UPDATE lookup_columns SET broken = ?, updated_at = datetime('now')
      WHERE other_sheet_id = ? AND broken IS NULL`).run(trashedLookupMessage(s.name), s.id);
  }
  return { runs, listRuns, sources };
}

// trashId: null when Settings keeps nothing (it's being deleted for good).
// Kept 0 days: the item is born 'purging', and the sweep deletes it for good now.
const keptOr = (userId: string) => (trashKeeps(userId) ? 'kept' as const : 'purging' as const);

export type SheetTrashOutcome =
  | { ok: { trashId: number | null; notAdded: ResultsNotAdded | null } }
  | TrashFail;

export function trashSheet(userId: string, tableId: string, sheetId: string): SheetTrashOutcome {
  const sheet = db.prepare(`SELECT s.id FROM sheets s JOIN tables t ON t.id = s.table_id WHERE s.id = ?
    AND s.table_id = ? AND s.user_id = ? AND s.trash_id IS NULL AND t.trash_id IS NULL`).get(sheetId, tableId, userId);
  if (!sheet) return { fail: 'not_found', message: 'Sheet not found' };
  const busy = sheetBusyWith(sheetId);
  if (busy) return { fail: 'conflict', message: busyMessage(busy) };

  let last = false;
  let trashId = 0;
  let retired: Retired = { runs: [], listRuns: [], sources: [] };
  let notAdded: ResultsNotAdded | null = null;
  db.transaction(() => {
    const live = db.prepare('SELECT COUNT(*) FROM sheets WHERE table_id = ? AND user_id = ? AND trash_id IS NULL')
      .pluck().get(tableId, userId) as number;
    if (live <= 1) { last = true; return; }
    notAdded = resultsNotAdded(sheetId, userId);
    retired = retireSheets([sheetId], userId);
    trashId = insertTrashItem({
      userId, kind: 'sheet', how: 'sheet', tableId, sheetId, rowCount: countRows(sheetId, userId),
      state: keptOr(userId),
    });
    db.prepare('UPDATE sheets SET trash_id = ? WHERE id = ? AND user_id = ?').run(trashId, sheetId, userId);
    logSheetChange(sheetId, userId, 'sheet_deleted', 'Deleted the sheet', { detail: { trash_id: trashId } });
  }).immediate();
  if (last) return { fail: 'bad_request', message: 'A table must have at least one sheet.' };
  afterRetire(retired, userId);
  return { ok: { trashId: trashKeeps(userId) ? trashId : null, notAdded } };
}

export type TableTrashOutcome = { ok: { trashId: number | null } } | TrashFail;


export function trashTable(userId: string, tableId: string): TableTrashOutcome {
  if (!db.prepare('SELECT 1 FROM tables WHERE id = ? AND user_id = ? AND trash_id IS NULL').get(tableId, userId)) {
    return { fail: 'not_found', message: 'Table not found' };
  }
  const sheetIds = db.prepare('SELECT id FROM sheets WHERE table_id = ? AND user_id = ? AND trash_id IS NULL')
    .pluck().all(tableId, userId) as string[];
  const busy = sheetIds.map(sheetBusyWith).find(Boolean);
  if (busy) return { fail: 'conflict', message: busyMessage(busy) };

  let trashId = 0;
  let retired: Retired = { runs: [], listRuns: [], sources: [] };
  db.transaction(() => {
    retired = retireSheets(sheetIds, userId);
    const rows = sheetIds.reduce((n, id) => n + countRows(id, userId), 0);
    trashId = insertTrashItem({
      userId, kind: 'table', how: 'table', tableId, sheetId: null, rowCount: rows, state: keptOr(userId),
    });
    db.prepare('UPDATE tables SET trash_id = ? WHERE id = ? AND user_id = ?').run(trashId, tableId, userId);
    // Its sheets go with it (one already in the trash keeps its own item).
    db.prepare('UPDATE sheets SET trash_id = ? WHERE table_id = ? AND user_id = ? AND trash_id IS NULL')
      .run(trashId, tableId, userId);
    for (const id of sheetIds) {
      logSheetChange(id, userId, 'sheet_deleted', 'Deleted with its table', { detail: { trash_id: trashId } });
    }
  }).immediate();
  afterRetire(retired, userId);
  return { ok: { trashId: trashKeeps(userId) ? trashId : null } };
}

function afterRetire(retired: Retired, userId: string): void {
  for (const [kind, id] of retired.runs) {
    clearRunPlaceholders(kind, id)
      .catch(err => console.error(`Clearing the cells of cancelled ${kind} run ${id} failed (retried later):`, err));
  }
  clearListRunCells(retired.listRuns);
  dropBucketsForSheets(retired.sources);
  // Kept 0 days: gone for good now, a slice at a time.
  if (!trashKeeps(userId)) kickTrashPurge();
}
