// Filling a clean data column (clean_columns, migration 024): each row's
// source value, cleaned (lib/clean/), with no request and no cost. It runs
// with the sheet busy (lib/sheet-busy.ts), so no edit lands between a row's
// read and its write, in storage (rowid) order (lib/row-order.ts): each slice
// reads its rows, writes the cells that change and moves the cursor in one
// short transaction. A restart goes on from the cursor (resumeCleanFills at
// boot). Writes are idempotent; a slice that fails is retried a few times,
// then the fill ends as failed and frees the sheet. Every read shows the
// column as processing until the fill is done (lib/field-fill-columns.ts).
import { db } from '../lib/db';
import { jsonPath } from '../lib/sql-rows';
import { eachRowIdSlice, sheetRowIds } from '../lib/row-order';
import { stayBusyToFinish, whenSheetFree } from '../lib/sheet-busy';
import { markAutorunInputs } from '../lib/autorun-mark';
import { loadCleanColumn, type CleanColumnRow } from '../lib/clean-columns';
import { cleanerForRecord } from '../lib/clean/cleaners';
import { redactSecrets } from '../lib/redact';
import { writeCleanCells, type CleanCellRead } from './clean-write';

export const CLEANING = 'cleaning a column';
const FILL_ATTEMPTS = 5;

async function work(job: CleanColumnRow): Promise<void> {
  const clean = cleanerForRecord(job.cleaner, job.options);
  if (!clean) {
    finishFill(job, 'failed', `This version of Cubex doesn't know the cleaner "${job.cleaner}".`);
    return;
  }
  const all = await sheetRowIds(job.sheet_id, job.user_id);
  const rowIds = job.fill_cursor > 0 ? all.filter(id => id > job.fill_cursor) : all;
  const read = db.prepare(`SELECT rowid AS rowid, json_extract(data, ?) AS source, json_extract(data, ?) AS cell
    FROM rows WHERE rowid IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ? ORDER BY rowid`);
  const move = db.prepare(`UPDATE clean_columns SET fill_cursor = ?, filled_rows = filled_rows + ?,
    blanked_rows = blanked_rows + ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ? AND fill_status = 'filling'`);
  const sourcePath = jsonPath(job.source_column);
  const cellPath = jsonPath(job.column_name);
  let stopped = false;
  await eachRowIdSlice(rowIds, idsJson => {
    db.transaction(() => {
      // Edited or cleaned again meanwhile (an agent's second call): this fill is over.
      const now = loadCleanColumn(job.id);
      if (!now || now.fill_status !== 'filling' || now.cleaner !== job.cleaner || now.options !== job.options
        || now.source_column !== job.source_column || now.column_name !== job.column_name) {
        stopped = true;
        return;
      }
      const rows = read.all(sourcePath, cellPath, idsJson, job.sheet_id, job.user_id) as CleanCellRead[];
      const counts = writeCleanCells(job.user_id, cellPath, rows, clean);
      // A column another column's auto-run reads queues these rows for it.
      markAutorunInputs(job.sheet_id, job.user_id, [job.column_name], { rowids: counts.changed });
      const last = JSON.parse(idsJson) as number[];
      move.run(last[last.length - 1], counts.filled, counts.blanked, job.id, job.user_id);
    }).immediate();
    return !stopped;
  });
  if (!stopped) finishFill(job, 'done', null);
}

function finishFill(job: CleanColumnRow, status: 'done' | 'failed', error: string | null): void {
  db.transaction(() => {
    db.prepare(`UPDATE clean_columns SET fill_status = ?, error_message = ?, updated_at = datetime('now')
      WHERE id = ? AND user_id = ? AND fill_status = 'filling'`).run(status, error, job.id, job.user_id);
    // Open tabs reload and the column's ⏳ give way to its values.
    db.prepare(`UPDATE sheets SET data_version = data_version + 1, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?`).run(job.sheet_id, job.user_id);
  }).immediate();
}

// Runs (or resumes) the fill as the sheet's heavy operation; call inside it.
export async function runCleanFill(id: string): Promise<void> {
  const job = loadCleanColumn(id);
  if (!job || job.fill_status !== 'filling') return;
  try {
    await work(job);
  } catch (err) {
    console.error(`Cleaning column "${job.column_name}" on sheet ${job.sheet_id} failed, retrying:`, err);
    let attempts = 1;
    stayBusyToFinish(job.sheet_id, CLEANING, async () => {
      const again = loadCleanColumn(id);
      if (!again || again.fill_status !== 'filling') return;
      try {
        await work(again);
      } catch (e) {
        if (++attempts < FILL_ATTEMPTS) throw e;
        console.error(`Cleaning column "${job.column_name}" on sheet ${job.sheet_id} gave up:`, e);
        finishFill(again, 'failed', redactSecrets(String((e as Error)?.message ?? e)).slice(0, 500));
      }
    });
  }
}

// At boot, before serving: every unfinished fill marks its sheet busy at once.
export function resumeCleanFills(): void {
  const jobs = db.prepare(`SELECT id, sheet_id FROM clean_columns WHERE fill_status = 'filling'
    ORDER BY updated_at`).all() as Array<{ id: string; sheet_id: string }>;
  for (const j of jobs) {
    whenSheetFree(j.sheet_id, CLEANING, () => runCleanFill(j.id))
      .catch(err => console.error(`Finishing the column clean on sheet ${j.sheet_id} failed:`, err));
  }
}

// An agent's answer waits for the fill, up to `ms` (it polls the record, so a
// fill resumed at boot counts too).
export async function waitForCleanFill(id: string, ms: number): Promise<CleanColumnRow | undefined> {
  const until = Date.now() + ms;
  for (;;) {
    const row = loadCleanColumn(id);
    if (!row || row.fill_status !== 'filling' || Date.now() >= until) return row;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
