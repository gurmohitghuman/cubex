// Resuming auto-run paused by hand (the sheet header's chip, a column's Resume, set_auto_run, the REST routes), with
// what becomes of the rows that waited meanwhile (added, or their inputs written, while it was paused):
// - run (the default, as before): they run now.
// - empty_only ("keep existing results"): a waiting row whose cell already holds a value is dropped; one whose cell
//   is empty runs, and so do rows added meanwhile (above its watermark).
// - skip ("continue without running"): every waiting row is dropped and the watermark moved to the top row, so
//   only rows added or changed from now on run.
// The rows are dropped in slices while the columns are still paused (no batch starts on one meanwhile), the WAL
// copied back on the checkpoint worker (lib/bulk-slices.ts), safe at 1M rows; then the resume. Only run columns
// (AI, HTTP API, enrichment, waterfall): clean, formula and lookup columns follow their inputs for free.
import { db } from '../lib/db';
import { HEAVY_SLICE_ROWS } from '../lib/constants';
import { runInCheckpointedSlices } from '../lib/bulk-slices';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { jsonPath } from '../lib/json-path';
import { BLANK_CHARS, CONDITION_NOT_MET } from '../lib/run-markers';
import { setSheetAutorunPaused } from './autorun-settings';

export const WAITING_ROWS = ['run', 'empty_only', 'skip'] as const;
export type WaitingRows = typeof WAITING_ROWS[number];
export const waitingRowsOf = (v: unknown): WaitingRows | null | undefined =>
  (v === undefined || v === null ? undefined : (WAITING_ROWS as readonly unknown[]).includes(v) ? v as WaitingRows
    : null);
export const WAITING_ROWS_REFUSAL = (name: string) => `${name} must be run, empty_only or skip.`;

interface Entry { id: string; status_column: string }

// Waiting rows whose cell holds a value: a result, or ❌ (kept, not tried again). Blank and "⏭️ Condition not met"
// read as not run yet, as auto-run reads them (lib/autorun-mark.ts NOT_RUN), so those rows still run. A slice of
// waiting rows at a time in row id order, the queue's own key, so a slice reads at most HEAVY_SLICE_ROWS of them
// whatever else waits (by rowid, a sheet without planner stats sorted every waiting row in each slice).
async function dropFilled(e: Entry): Promise<void> {
  const end = db.prepare(`SELECT MAX(row_id) FROM (SELECT row_id FROM autorun_pending WHERE autorun_id = ?
    AND row_id > ? ORDER BY row_id LIMIT ?)`).pluck();
  const del = db.prepare(`DELETE FROM autorun_pending WHERE rowid IN (SELECT p.rowid FROM autorun_pending p
    JOIN rows r ON r.id = p.row_id WHERE p.autorun_id = ? AND p.row_id > ? AND p.row_id <= ?
      AND TRIM(COALESCE(json_extract(r.data, ?), ''), ?) NOT IN ('', ?))`);
  const cell = jsonPath(e.status_column);
  let after = '';
  await runInCheckpointedSlices(() => {
    const upTo = end.get(e.id, after, HEAVY_SLICE_ROWS) as string | null;
    if (upTo === null) return false;
    del.run(e.id, after, upTo, cell, BLANK_CHARS, CONDITION_NOT_MET);
    after = upTo;
    return true;
  });
}

async function dropAll(sheetId: string, userId: string, e: Entry): Promise<void> {
  const del = db.prepare(`DELETE FROM autorun_pending WHERE rowid IN (SELECT rowid FROM autorun_pending
    WHERE autorun_id = ? LIMIT ?)`);
  await runInCheckpointedSlices(() => del.run(e.id, HEAVY_SLICE_ROWS).changes >= HEAVY_SLICE_ROWS);
  db.prepare(`UPDATE autorun_columns SET watermark_row_index = MAX(watermark_row_index,
      (SELECT IFNULL(MAX(row_index), -1) FROM rows WHERE sheet_id = ? AND user_id = ?)) WHERE id = ?`)
    .run(sheetId, userId, e.id);
}

// Resumes every auto-run on the sheet, or the column's, once the waiting rows are dealt with: only a paused one's
// (one still running didn't wait; its queue is rows about to run). False: no such sheet.
export async function resumeAutorun(
  userId: string, sheetId: string, waiting: WaitingRows = 'run', column?: string,
): Promise<boolean> {
  if (!verifySheetOwnership(sheetId, userId)) return false;
  if (waiting !== 'run') {
    const one = column === undefined ? '' : ' AND status_column = ?';
    const entries = db.prepare(`SELECT id, status_column FROM autorun_columns WHERE sheet_id = ? AND user_id = ?
      AND enabled = 1 AND paused_reason IS NOT NULL AND kind NOT IN ('clean', 'formula', 'lookup')${one}`)
      .all(...(column === undefined ? [sheetId, userId] : [sheetId, userId, column])) as Entry[];
    for (const e of entries) {
      if (waiting === 'skip') await dropAll(sheetId, userId, e); else await dropFilled(e);
    }
  }
  return setSheetAutorunPaused(userId, sheetId, false, column, waiting);
}
