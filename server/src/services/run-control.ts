import { db } from '../lib/db';
import { failedCell } from '../lib/enrich-cells';
import { clearRunPlaceholders } from '../lib/run-placeholders';
import { destsGone } from './enrich-list-source';

// Abort any in-flight AI/HTTP runs whose owning sheet is about to be deleted.
//
// Sidequest worker threads can't observe in-process state from the API
// process, so we cancel via the DB: set status='cancelled' on every active
// run for this sheet. The worker's per-row DB-poll picks this up on its
// next iteration (within ~one OpenRouter call latency) and exits cleanly
// without writing further results.
//
// Without this, the runner keeps making OpenRouter / target-API calls
// after the parent rows are gone (FK CASCADE wipes ai_runs / http_runs),
// and then errors trying to INSERT into ai_results.
//
// Call this BEFORE running DELETE on the sheets/tables.
export function abortRunsForSheets(sheetIds: string[]): void {
  if (sheetIds.length === 0) return;
  const placeholders = sheetIds.map(() => '?').join(',');

  db.prepare(
    `UPDATE ai_runs SET status = 'cancelled', updated_at = datetime('now')
     WHERE sheet_id IN (${placeholders}) AND status IN ('pending','running','paused')`
  ).run(...sheetIds);

  db.prepare(
    `UPDATE http_runs SET status = 'cancelled', updated_at = datetime('now')
     WHERE sheet_id IN (${placeholders}) AND status IN ('pending','running','paused')`
  ).run(...sheetIds);
}

export function abortRunsForTable(tableId: string): void {
  const sheetIds = (db.prepare(
    'SELECT id FROM sheets WHERE table_id = ?'
  ).all(tableId) as Array<{ id: string }>).map(r => r.id);
  abortRunsForSheets(sheetIds);
}

// A list job's destination about to be deleted (call in the delete
// transaction, before the cascade drops the results still waiting there):
// the runs adding rows to it are cancelled, and their source rows say the
// results weren't added. Returns the cancelled runs: clear their ⏳ cells
// after the commit (clearListRunCells). The source sheet stays.
export function abortListRunsInto(sheetIds: string[]): string[] {
  if (sheetIds.length === 0) return [];
  const ids = JSON.stringify(sheetIds);
  const runs = db.prepare(`SELECT id FROM http_runs WHERE dest_sheet_id IN (SELECT value FROM json_each(?))
    AND status IN ('pending','running','paused')`).pluck().all(ids) as string[];
  db.prepare(`UPDATE http_runs SET status = 'cancelled', placeholder_work = 'clearing', updated_at = datetime('now')
    WHERE id IN (SELECT value FROM json_each(?))`).run(JSON.stringify(runs));
  destsGone(sheetIds, failedCell('Rows not added: the sheet for them was deleted.'));
  return runs;
}

export function clearListRunCells(runIds: string[]): void {
  for (const id of runIds) {
    clearRunPlaceholders('http', id)
      .catch(err => console.error(`Clearing the cells of cancelled run ${id} failed (retried later):`, err));
  }
}
