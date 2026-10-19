// Filling a column added from an answer (enrichment_field_jobs, migrations
// 010 and 018).
// Over 200 lines: the two stages share the job's cursor and its resume.
// Every row gets what its stored answer holds at the path, from
// the newest run of the status column with a result at that row. No treg
// calls, no requests, no cost. It runs with the sheet busy (lib/sheet-busy.ts)
// and the column's runs stopped, so nothing it reads can change, in two stages:
//   link: the new column is linked to each of the column's older runs (the
//     newest got it when the column was added), a batch per transaction;
//   fill: the runs newest first, each one's results read once in row order;
//     a row takes the first run that answered it (completed or failed, and
//     not taken back by an undo: migration 044), later (older) runs skip it.
// So the work follows the results, never runs x rows: auto-run leaves a run
// per batch, and a column can hold tens of thousands of them. Each slice
// works out its cells outside the write lock, then writes them and moves the
// job's cursor in one short transaction; a restart goes on from the cursor
// (resumeFieldJobs at boot). Writes are idempotent; a slice that fails is
// retried a few times, then the job ends as failed and frees the sheet.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { HEAVY_SLICE_ROWS } from '../lib/constants';
import { jsonPath } from '../lib/sql-helpers';
import { runInSlices, yieldToRequests } from '../lib/slices';
import { stayBusyToFinish, whenSheetFree } from '../lib/sheet-busy';
import { enrichmentFieldCell, httpFieldCell, type StoredResult } from '../lib/answer-field';
import { statusColumnRuns, type ColumnRunRef } from './answer-runs';
import { markAutorunInputs } from '../lib/autorun-mark';

export { FILL_PLACEHOLDER, fillingColumns } from '../lib/field-fill-columns';
const FILLING = 'filling a column';
const FILL_ATTEMPTS = 5;
const LINK_BATCH = 200;

interface FieldJob {
  id: string; user_id: string; sheet_id: string; status_column: string; column_name: string; json_path: string;
  status: string; stage: 'link' | 'fill'; run_pos: number; row_cursor: number;
}

const loadJob = (id: string): FieldJob | undefined =>
  db.prepare('SELECT * FROM enrichment_field_jobs WHERE id = ?').get(id) as FieldJob | undefined;

// Rows a newer run already answered: a byte per row index, grown as needed.
class RowSet {
  private bits = new Uint8Array(1024);
  has(i: number): boolean { return i < this.bits.length && this.bits[i] === 1; }
  add(i: number): void {
    if (i >= this.bits.length) {
      const next = new Uint8Array(Math.max(i + 1, this.bits.length * 2));
      next.set(this.bits);
      this.bits = next;
    }
    this.bits[i] = 1;
  }
}

// How a run's answers become this column's cells: an enrichment by its own
// rule (a single tool's "not found" only meant its picked outputs were empty,
// so a new field from its answer fills, as a rerun with that output would).
function cellRule(runId: string, userId: string, path: string): (r: StoredResult) => string | null {
  const k = db.prepare(`SELECT json_type(config, '$.enrichment') AS e,
      json_extract(config, '$.enrichment.kind') AS kind, json_type(config, '$.enrichment.email') AS email
    FROM http_runs WHERE id = ? AND user_id = ?`)
    .get(runId, userId) as { e: string | null; kind: string | null; email: string | null } | undefined;
  if (!k?.e) return r => httpFieldCell(r, path);
  const single = k.kind === 'single' && (k.email === null || k.email === 'null');
  return r => enrichmentFieldCell(r, path, single);
}

// Stage 1: link the column to every run of the status column, a batch a transaction.
async function link(job: FieldJob, runs: ColumnRunRef[]): Promise<void> {
  const insert = db.prepare(`INSERT INTO http_column_associations
      (id, sheet_id, user_id, master_column_name, extracted_column_name, run_id)
    SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM http_column_associations
      WHERE run_id = ? AND extracted_column_name = ? AND +sheet_id = ? AND +user_id = ?)`);
  const move = db.prepare(`UPDATE enrichment_field_jobs SET run_pos = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ? AND status = 'running'`);
  for (let i = job.run_pos; i < runs.length; i += LINK_BATCH) {
    const batch = runs.slice(i, i + LINK_BATCH);
    db.transaction(() => {
      for (const r of batch) {
        insert.run(uuidv4(), job.sheet_id, job.user_id, job.status_column, job.column_name, r.id,
          r.id, job.column_name, job.sheet_id, job.user_id);
      }
      move.run(i + batch.length, job.id, job.user_id);
    }).immediate();
    await yieldToRequests();
  }
  db.prepare(`UPDATE enrichment_field_jobs SET stage = 'fill', run_pos = 0, row_cursor = -1,
    updated_at = datetime('now') WHERE id = ? AND user_id = ? AND status = 'running'`).run(job.id, job.user_id);
}

const readSlice = (runId: string, userId: string, after: number) => db.prepare(`SELECT row_index, status, undone,
    response_data FROM http_results WHERE run_id = ? AND row_index > ? AND +user_id = ? ORDER BY row_index LIMIT ?`)
  .all(runId, after, userId, HEAVY_SLICE_ROWS) as Array<StoredResult & { row_index: number; undone: number }>;

const answered = (r: { status: string; undone: number }) =>
  (r.status === 'completed' || r.status === 'failed') && r.undone === 0;

// After a restart: the rows the runs before the cursor answered (and, for the
// run at the cursor, the rows before its row cursor) are taken already.
async function rebuildTaken(job: FieldJob, runs: ColumnRunRef[], taken: RowSet): Promise<void> {
  const read = db.prepare(`SELECT row_index, status, undone FROM http_results WHERE run_id = ? AND row_index > ?
    AND row_index <= ? AND +user_id = ? ORDER BY row_index LIMIT ?`);
  for (let p = 0; p <= Math.min(job.run_pos, runs.length - 1); p++) {
    const upTo = p < job.run_pos ? Number.MAX_SAFE_INTEGER : job.row_cursor;
    for (let after = -1; ;) {
      const rows = read.all(runs[p].id, after, upTo, job.user_id, HEAVY_SLICE_ROWS) as
        Array<{ row_index: number; status: string; undone: number }>;
      for (const r of rows) if (answered(r)) taken.add(r.row_index);
      if (rows.length < HEAVY_SLICE_ROWS) break;
      after = rows[rows.length - 1].row_index;
      await yieldToRequests();
    }
  }
}

// Stage 2: each run's results once, newest run first.
async function fill(job: FieldJob, runs: ColumnRunRef[]): Promise<void> {
  const taken = new RowSet();
  if (job.run_pos > 0 || job.row_cursor > -1) await rebuildTaken(job, runs, taken);
  const write = db.prepare(`UPDATE rows SET data = json_set(data, ?, ?)
    WHERE sheet_id = ? AND user_id = ? AND row_index = ?`);
  const move = db.prepare(`UPDATE enrichment_field_jobs SET run_pos = ?, row_cursor = ?,
    updated_at = datetime('now') WHERE id = ? AND user_id = ? AND status = 'running'`);
  const cellPath = jsonPath(job.column_name);
  let pos = job.run_pos;
  let after = job.row_cursor;
  let cell = pos < runs.length ? cellRule(runs[pos].id, job.user_id, job.json_path) : null;
  await runInSlices(() => {
    if (pos >= runs.length || !cell) return false;
    const results = readSlice(runs[pos].id, job.user_id, after);
    const cells: Array<[number, string]> = [];
    for (const r of results) {
      if (!answered(r) || taken.has(r.row_index)) continue;
      taken.add(r.row_index);
      const value = cell(r);
      if (value !== null) cells.push([r.row_index, value]);
    }
    const done = results.length < HEAVY_SLICE_ROWS;
    const nextPos = done ? pos + 1 : pos;
    const nextAfter = done ? -1 : results[results.length - 1].row_index;
    db.transaction(() => {
      for (const [rowIndex, value] of cells) write.run(cellPath, value, job.sheet_id, job.user_id, rowIndex);
      // A column another column's auto-run reads queues these rows for it.
      markAutorunInputs(job.sheet_id, job.user_id, [job.column_name], { indexes: cells.map(c => c[0]) });
      move.run(nextPos, nextAfter, job.id, job.user_id);
    }).immediate();
    pos = nextPos;
    after = nextAfter;
    if (done && pos < runs.length) cell = cellRule(runs[pos].id, job.user_id, job.json_path);
    return pos < runs.length;
  });
  finishJob(job, 'done', null);
}

async function work(job: FieldJob): Promise<void> {
  // The sheet is busy and the column's runs stopped: this list doesn't change.
  const runs = statusColumnRuns(job.sheet_id, job.user_id, job.status_column);
  if (job.stage !== 'fill') {
    await link(job, runs);
    const next = loadJob(job.id);
    if (!next || next.status !== 'running') return;
    job = next;
  }
  await fill(job, runs);
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
    await work(job);
  } catch (err) {
    console.error(`Filling column "${job.column_name}" on sheet ${job.sheet_id} failed, retrying:`, err);
    let attempts = 1;
    stayBusyToFinish(job.sheet_id, FILLING, async () => {
      const again = loadJob(jobId);
      if (!again || again.status !== 'running') return;
      try {
        await work(again);
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
