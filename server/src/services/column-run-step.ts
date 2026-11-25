// Starting one column of a column run (setup-runner.ts): the column's own
// rerun with its newest setup, as the column menu's run controls start it
// (run-controls.ts), on the rows the run's mode picks, among the chosen rows:
// the record's row_ids, or the rows its where matches now, read in slices.
// Before it starts: the clean, formula and lookup columns it reads earlier
// columns through must have caught up (they follow on their own, so the step
// waits for them), and a run already working on the column is waited for (a
// paused one ends the run with a message: nothing would resume it). No row
// to do counts as done. limitUsd: what is left of the ceiling
// (setup-ceiling.ts), an AI run's hard limit and the most an enrichment's or
// a waterfall's own limit may be.
import { db } from '../lib/db';
import { hasSpanWork } from '../lib/derived-spans';
import { entryFor } from './autorun-entry';
import { runColumnOf } from './run-controls-column';
import { startRunControl } from './run-controls';
import type { RunRows } from './run-controls-target';
import { columnRunNow, type AgainStart } from './setup-step-again';
import { rowIdPlaces, selectedRowsProblem, wherePlaces } from './column-run-rows';
import type { ColumnRunMode } from './column-run-input';
import type { ColumnRunSpec, ColumnRunStep, SetupRunRow } from './setup-run-store';

// A column run's mode as the run controls name rows (also its estimate's).
export const ROWS: Record<ColumnRunMode, RunRows> = {
  empty: 'empty', errored: 'failed', out_of_date: 'out_of_date', empty_or_out_of_date: 'empty_or_out_of_date',
  all: 'all',
};
const NONE_LEFT = 'No row needed it.';

// Whether a derived column that follows its columns is still working out rows
// written so far. One that doesn't follow (auto-run off or paused) won't change: not waited for.
function catchingUp(sheetId: string, userId: string, column: string): boolean {
  const e = entryFor(sheetId, userId, column);
  if (!e || !e.enabled || e.paused_reason) return false;
  const args = [sheetId, userId, column];
  const filling = db.prepare(`SELECT 1 FROM clean_columns WHERE sheet_id = ? AND user_id = ? AND column_name = ?
      AND fill_status = 'filling'`).get(...args)
    ?? db.prepare(`SELECT 1 FROM formula_columns WHERE sheet_id = ? AND user_id = ? AND column_name = ?
      AND fill_status = 'filling'`).get(...args)
    ?? db.prepare(`SELECT 1 FROM lookup_columns WHERE sheet_id = ? AND user_id = ? AND column_name = ?
      AND fill_status = 'filling'`).get(...args);
  if (filling || e.rescan) return true;
  if (db.prepare('SELECT 1 FROM autorun_pending WHERE autorun_id = ? LIMIT 1').get(e.id) || hasSpanWork(e.id)) {
    return true;
  }
  const top = db.prepare('SELECT IFNULL(MAX(row_index), -1) FROM rows WHERE sheet_id = ? AND user_id = ?')
    .pluck().get(sheetId, userId) as number;
  return top > e.watermark_row_index;
}

export async function startColumnStep(
  r: SetupRunRow, step: ColumnRunStep, spec: ColumnRunSpec, opts: { allowSecrets: boolean; limitUsd: number | null },
): Promise<AgainStart> {
  const run = runColumnOf(r.sheet_id, r.user_id, step.column);
  if (!run || run.main !== step.column || run.kind !== step.kind) {
    return { fail: 'not_found', message: `"${step.column}" isn't the same run column any more.` };
  }
  if (step.between.some(c => catchingUp(r.sheet_id, r.user_id, c))) return { wait: true };
  const table = step.kind === 'ai' ? 'ai' : 'http';
  const now = columnRunNow(r.sheet_id, r.user_id, table, step.column);
  if (now === 'active') return { wait: true };
  if (now === 'paused') {
    return { fail: 'conflict', message: `A run on "${step.column}" is paused. Resume or stop it, then run the `
      + 'columns again.' };
  }
  const ids = r.target_row_ids ? JSON.parse(r.target_row_ids) as string[] : null;
  let within: number[] | null = ids ? rowIdPlaces(r.sheet_id, r.user_id, ids) : null;
  if (!within && spec.where) {
    const rows = await wherePlaces(r.sheet_id, r.user_id, spec.where);
    if ('problem' in rows) return { fail: 'bad_request', message: `Its where can't be read any more: ${rows.problem}` };
    const over = selectedRowsProblem([step.kind], rows.length);
    if (over) return { fail: 'bad_request', message: over };
    within = rows;
  }
  if (within?.length === 0) return { done: NONE_LEFT };
  const out = await startRunControl(r.user_id, r.sheet_id, run, { rows: ROWS[spec.mode], within }, {
    rowGeneration: null, spendLimitUsd: null, spendCeilingUsd: opts.limitUsd, allowSecrets: opts.allowSecrets,
  });
  if ('ok' in out) return { ok: { kind: table, runId: out.ok.runId } };
  if (out.nothingToRun) return { done: NONE_LEFT };
  // A run (auto-run, or one started by hand) began on it since the check: wait for it.
  if (out.fail === 'conflict' && columnRunNow(r.sheet_id, r.user_id, table, step.column) === 'active') {
    return { wait: true };
  }
  return out;
}
