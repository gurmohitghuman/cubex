// Where each step of a setup being used is (setup-runner.ts): the run or
// record its start made, how that is getting on, the one a start interrupted
// by a restart made, and the test rows' places now.
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { mainColumn, type SetupStep } from '../lib/setups/spec';
import { pauseRun } from './run-lifecycle';
import { followProgress } from './setup-step-again';
import { stepsOf, type SetupRunRow, type StepRecord } from './setup-run-store';

type StepKind = NonNullable<StepRecord['kind']>;
type RunState = { status: string; error_message: string | null } | undefined;

// The run or record a started step made: how it is now. Each statement is
// written out in its own prepare, so the SQL check reads it.
function stateOf(st: StepRecord): RunState {
  const id = st.runId ?? st.recordId;
  switch (st.kind as StepKind) {
    case 'ai': return db.prepare('SELECT status, error_message FROM ai_runs WHERE id = ?').get(id) as RunState;
    case 'http': return db.prepare('SELECT status, error_message FROM http_runs WHERE id = ?').get(id) as RunState;
    case 'clean':
      return db.prepare('SELECT fill_status AS status, error_message FROM clean_columns WHERE id = ?').get(id) as
        RunState;
    case 'formula':
      return db.prepare('SELECT fill_status AS status, error_message FROM formula_columns WHERE id = ?').get(id) as
        RunState;
  }
}

// What a step's start made, made since the setup started (a record kept from
// before, or a run started by hand earlier, isn't it). Saving a clean or
// formula column again keeps its record, so those go by when it was saved.
function madeSince(kind: StepKind, r: SetupRunRow, column: string): string | undefined {
  const args = [r.sheet_id, r.user_id, column, r.created_at];
  switch (kind) {
    case 'ai': return db.prepare(`SELECT id FROM ai_runs WHERE sheet_id = ? AND user_id = ? AND column_name = ?
      AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).pluck().get(...args) as string | undefined;
    case 'http': return db.prepare(`SELECT id FROM http_runs WHERE sheet_id = ? AND user_id = ?
      AND master_column_name = ? AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).pluck()
      .get(...args) as string | undefined;
    case 'clean': return db.prepare(`SELECT id FROM clean_columns WHERE sheet_id = ? AND user_id = ?
      AND column_name = ? AND updated_at >= ?`).pluck().get(...args) as string | undefined;
    case 'formula': return db.prepare(`SELECT id FROM formula_columns WHERE sheet_id = ? AND user_id = ?
      AND column_name = ? AND updated_at >= ?`).pluck().get(...args) as string | undefined;
  }
}

export type Progress = 'working' | 'done' | 'failed' | 'cancelled' | 'gone' | 'stopped';

// Where a started step is: 'working', or how it ended. A followed column
// (setup-step-again.ts) is done once its auto-run caught up; 'stopped': it no
// longer follows, so it's to be filled again.
export function progress(r: SetupRunRow, st: StepRecord, step: SetupStep): Progress {
  if (st.follow && (st.kind === 'clean' || st.kind === 'formula')) {
    return followProgress(r.sheet_id, r.user_id, st.kind, mainColumn(step));
  }
  const s = stateOf(st);
  if (!s) return 'gone';
  if (s.status === 'completed' || s.status === 'done') return 'done';
  return s.status === 'failed' || s.status === 'cancelled' ? s.status : 'working';
}

export const runError = (st: StepRecord): string | null => stateOf(st)?.error_message ?? null;

// A step marked 'starting' when the server stopped: the run (or record) its
// start made, if it got that far.
export function adopt(r: SetupRunRow, step: SetupStep): StepRecord | null {
  const main = mainColumn(step);
  if (!getSheetColumns(r.sheet_id, r.user_id, false).includes(main)) return null;
  const kind = step.kind === 'enrichment' ? 'http' : step.kind;
  const id = madeSince(kind, r, main);
  if (!id) return null;
  return kind === 'clean' || kind === 'formula'
    ? { state: 'running', kind, recordId: id } : { state: 'running', kind, runId: id };
}

// A paused setup's runs stay paused: a run still writing its placeholders
// when the pause came couldn't be paused then (run-lifecycle.ts), so each
// sweep tries again until it is, or has ended.
export function holdPaused(r: SetupRunRow): void {
  for (const st of stepsOf(r)) {
    if (st.state !== 'running' || (st.kind !== 'ai' && st.kind !== 'http')) continue;
    const s = stateOf(st);
    if (s && !['completed', 'failed', 'cancelled'].includes(s.status)) pauseRun(st.kind, st.runId!, r.user_id);
  }
}

// The test rows' places now (a sort may have moved them since); null: every row.
export function rowIndexes(r: SetupRunRow): number[] | null {
  if (!r.target_row_ids) return null;
  const ids = JSON.parse(r.target_row_ids) as string[];
  const ph = ids.map(() => '?').join(',');
  return db.prepare(`SELECT row_index FROM rows WHERE sheet_id = ? AND user_id = ? AND id IN (${ph})
    ORDER BY row_index`).pluck().all(r.sheet_id, r.user_id, ...ids) as number[];
}
