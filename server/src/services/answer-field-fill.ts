// Filling a column added from an answer (enrichment_field_jobs, migration
// 010): every row gets what its stored answer holds at the path, from the
// newest run of the status column with a result at that row. No treg calls,
// no requests, no cost. It walks the rows in storage order a slice at a time
// with the sheet busy (lib/sheet-busy.ts). Each slice reads and works out its
// cells outside the write lock (the sheet is busy and the column's runs are
// stopped, so nothing it reads can change), then writes them and moves the
// job's cursor in one short transaction, so a restart picks up where it
// stopped (resumeFieldJobs at boot). Writes are idempotent; a slice that fails
// is retried a few times, then the job ends as failed and frees the sheet.
import { db } from '../lib/db';
import { HEAVY_SLICE_ROWS } from '../lib/constants';
import { jsonPath } from '../lib/sql-helpers';
import { sheetRowIds } from '../lib/row-order';
import { runInSlices } from '../lib/slices';
import { stayBusyToFinish, whenSheetFree } from '../lib/sheet-busy';
import { enrichmentFieldCell, httpFieldCell, type StoredResult } from '../lib/answer-field';
import { statusColumnRuns } from './answer-runs';

export const FILL_PLACEHOLDER = '⏳ Processing...';
const FILLING = 'filling a column';
const FILL_ATTEMPTS = 5;

interface FieldJob {
  id: string; user_id: string; sheet_id: string; status_column: string;
  column_name: string; json_path: string; cursor_rowid: number; status: string;
}

const loadJob = (id: string): FieldJob | undefined =>
  db.prepare('SELECT * FROM enrichment_field_jobs WHERE id = ?').get(id) as FieldJob | undefined;

// First index in the ascending `ids` past `cursor`.
function firstAfter(ids: Float64Array, cursor: number): number {
  let lo = 0, hi = ids.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (ids[mid] <= cursor) lo = mid + 1; else hi = mid; }
  return lo;
}

// The column's runs, newest first: an enrichment run fills by its own rule
// (a single tool's "not found" only meant its picked outputs were empty, so a
// new field from its answer fills, as a rerun with that output would).
function fillRuns(job: FieldJob): Array<{ id: string; cell: (r: StoredResult) => string | null }> {
  return statusColumnRuns(job.sheet_id, job.user_id, job.status_column).map(r => {
    const e = r.enrichment?.enrichment;
    const single = !!e && e.kind === 'single' && !e.email;
    return {
      id: r.id,
      cell: e ? (s: StoredResult) => enrichmentFieldCell(s, job.json_path, single)
        : (s: StoredResult) => httpFieldCell(s, job.json_path),
    };
  });
}

async function fill(job: FieldJob): Promise<void> {
  const runs = fillRuns(job);
  const ids = await sheetRowIds(job.sheet_id, job.user_id);
  const rowsOf = db.prepare(`SELECT rowid, row_index FROM rows
    WHERE rowid IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?`);
  const resultsOf = db.prepare(`SELECT row_index, status, response_data FROM http_results
    WHERE run_id = ? AND +user_id = ? AND row_index IN (SELECT value FROM json_each(?))`);
  const write = db.prepare('UPDATE rows SET data = json_set(data, ?, ?) WHERE rowid = ? AND +user_id = ?');
  const moveCursor = db.prepare(`UPDATE enrichment_field_jobs SET cursor_rowid = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ? AND status = 'running'`);
  const cellPath = jsonPath(job.column_name);
  let i = firstAfter(ids, job.cursor_rowid);
  await runInSlices(() => {
    if (i >= ids.length) return false;
    const slice = Array.from(ids.subarray(i, Math.min(ids.length, i + HEAVY_SLICE_ROWS)));
    const rows = rowsOf.all(JSON.stringify(slice), job.sheet_id, job.user_id) as
      Array<{ rowid: number; row_index: number }>;
    // Newest run first; each older run is asked only about rows still open.
    const open = new Map(rows.map(r => [r.row_index, r.rowid]));
    const cells: Array<[number, string]> = [];
    for (const run of runs) {
      if (open.size === 0) break;
      const found = resultsOf.all(run.id, job.user_id, JSON.stringify([...open.keys()])) as
        Array<StoredResult & { row_index: number }>;
      for (const r of found) {
        const rowid = open.get(r.row_index);
        if (rowid === undefined || (r.status !== 'completed' && r.status !== 'failed')) continue;
        open.delete(r.row_index);
        const cell = run.cell(r);
        if (cell !== null) cells.push([rowid, cell]);
      }
    }
    db.transaction(() => {
      for (const [rowid, cell] of cells) write.run(cellPath, cell, rowid, job.user_id);
      moveCursor.run(slice[slice.length - 1], job.id, job.user_id);
    }).immediate();
    i += slice.length;
    return i < ids.length;
  });
  finishJob(job, 'done', null);
}

function finishJob(job: FieldJob, status: 'done' | 'failed', error: string | null): void {
  db.transaction(() => {
    db.prepare(`UPDATE enrichment_field_jobs SET status = ?, error_message = ?, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?`).run(status, error, job.id, job.user_id);
    // Open tabs reload and the column's ⏳ give way to its values.
    db.prepare(`UPDATE sheets SET data_version = data_version + 1, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?`).run(job.sheet_id, job.user_id);
  }).immediate();
}

// Runs (or resumes) the job as the sheet's heavy operation; call inside it.
export async function runFieldJob(jobId: string): Promise<void> {
  const job = loadJob(jobId);
  if (!job || job.status !== 'running') return;
  try {
    await fill(job);
  } catch (err) {
    console.error(`Filling column "${job.column_name}" on sheet ${job.sheet_id} failed, retrying:`, err);
    let attempts = 1;
    stayBusyToFinish(job.sheet_id, FILLING, async () => {
      const again = loadJob(jobId);
      if (!again || again.status !== 'running') return;
      try {
        await fill(again);
      } catch (e) {
        if (++attempts < FILL_ATTEMPTS) throw e;
        console.error(`Filling column "${job.column_name}" on sheet ${job.sheet_id} gave up:`, e);
        finishJob(again, 'failed', String((e as Error)?.message ?? e).slice(0, 500));
      }
    });
  }
}

// At boot, before serving: every unfinished fill marks its sheet busy at once.
export function resumeFieldJobs(): void {
  const jobs = db.prepare(`SELECT id, sheet_id FROM enrichment_field_jobs WHERE status = 'running'
    ORDER BY created_at`).all() as Array<{ id: string; sheet_id: string }>;
  for (const j of jobs) {
    whenSheetFree(j.sheet_id, FILLING, () => runFieldJob(j.id))
      .catch(err => console.error(`Finishing the column fill on sheet ${j.sheet_id} failed:`, err));
  }
}

// Columns still filling on a sheet: the grid shows them as ⏳ until done.
export function fillingColumns(sheetId: string, userId: string): string[] {
  return db.prepare(`SELECT DISTINCT column_name FROM enrichment_field_jobs
    WHERE sheet_id = ? AND user_id = ? AND status = 'running'`).pluck().all(sheetId, userId) as string[];
}
