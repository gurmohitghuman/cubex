// Writing one waterfall row's result, in one transaction that first re-checks
// the run is still ours (a pause, cancel or resume that raced the steps drops
// the write: the row stays ⏳ and the resume replays its finished steps free):
// its http_results row (the cells, the trace, the row's cost), its cells, the
// run's per-step tallies, and the end of the row's kept step answers (a failed
// row keeps what it paid for, for a retry, waterfall-retry-kept.ts). When an
// enrichment step answered from a call of this run, its treg answer is stored
// with the row (raw part dropped) under a reuse key, so a later run of any
// sheet can reuse it (services/enrich-reuse.ts). A dry run writes no cells.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { touchSheet } from '../lib/sql-helpers';
import { enrichCellValues } from '../lib/enrich-cells';
import { withFill } from '../lib/answer-store';
import { trimAnswer } from '../lib/answer-trim';
import { nowDate } from '../lib/clock';
import { rowCells, traceCostUsd, type Trace, type TraceStep } from '../lib/waterfall/trace';
import { tallyKey } from '../lib/waterfall/keys';
import { rowSteps, type WaterfallRunConfig } from '../lib/waterfall/config';
import type { RunRow } from '../lib/run-rows';
import type { StepFrom } from '../lib/waterfall/trace';
import { shouldStopHttpRun, writeRowColumns } from './run-row-write';
import { answerTime, noteReusedRow } from './enrich-reuse';
import { dropRowAnswers } from './waterfall-journal';
import { keepForRetry, type RetryKept } from './waterfall-retry-kept';
import type { StepRun } from './waterfall-step-types';
import type { HTTPRunRow } from './http-runner-status';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

// The answering step: its treg answer (kept trimmed) and lookup key, if any.
export interface AnswerOf {
  stepId: string; from: StepFrom | null; body: unknown; reuseKey: string | null; routed: boolean;
}

// What a step's treg answer keeps: a waterfall tool's output and _treg (its
// raw part dropped, marked as a prune marks it, so a run reading raw never
// reuses it), a single tool's answer trimmed to the stored-answer budget.
export function keptBody(r: StepRun): unknown {
  if (r.body === undefined || r.body === null) return undefined;
  const kept = trimAnswer(r.body, !!r.routed);
  if (!r.routed || !isObj(kept) || !('raw' in kept)) return kept;
  const { raw: _raw, ...rest } = kept;
  return { ...rest, $prunedAt: answerTime(nowDate()) };
}

export interface WaterfallWrite {
  run: HTTPRunRow; config: WaterfallRunConfig; generation: number; row: RunRow;
  trace: TraceStep[]; answer: AnswerOf | null; scope: string; rowRef: string;
  kept: RetryKept[];              // what a retry shouldn't pay for again (kept only when the row failed)
}

// A found answer this run bought, kept whole enough for a later run to read:
// a treg waterfall's (its output stays whole; raw is dropped and marked), a
// single tool's only when nothing of it was cut (lib/enrich-reuse-key.ts reusableAnswer).
function reusable(a: AnswerOf): boolean {
  if (!a.reuseKey || a.body === undefined || a.body === null) return false;
  if (a.from !== null && a.from !== 'journal') return false;
  return a.routed || !(isObj(a.body) && Array.isArray(a.body.$trimmedPaths));
}

function stored(trace: Trace, answer: AnswerOf | null): unknown {
  const body = answer && isObj(answer.body) ? answer.body : null;
  const base = body ? { ...body } : {};
  const cubex = body && isObj(body._cubex) ? body._cubex : {};
  return withFill({ ...base, _cubex: { ...cubex, waterfall: trace } }, 'all');
}

function tally(run: HTTPRunRow, config: WaterfallRunConfig, trace: TraceStep[]): void {
  const w = config.waterfall;
  const keyOf = new Map(w.steps.map(s => [s.id, tallyKey(w, s)]));
  const up = db.prepare(`INSERT INTO waterfall_step_tally (run_id, step_id, user_id, step_key, reached, answered,
      rejected, failed, skipped, cost_usd) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, step_id) DO UPDATE SET reached = reached + 1, answered = answered + excluded.answered,
      rejected = rejected + excluded.rejected, failed = failed + excluded.failed, skipped = skipped + excluded.skipped,
      cost_usd = cost_usd + excluded.cost_usd`);
  for (const t of trace) {
    const cost = t.cost_usd + (t.check?.cost_usd ?? 0);
    up.run(run.id, t.id, run.user_id, keyOf.get(t.id) ?? '', t.outcome === 'answered' ? 1 : 0,
      t.outcome === 'rejected' ? 1 : 0, t.outcome === 'error' ? 1 : 0, t.outcome === 'no_inputs' ? 1 : 0, cost);
  }
}

// Returns false when the run was no longer ours (nothing written).
export function writeWaterfallRow(x: WaterfallWrite): boolean {
  const { run, config } = x;
  const trace: Trace = { v: 1, answered_by: x.answer?.stepId ?? null, steps: x.trace };
  const cells = rowCells(trace, rowSteps(config));
  const values = enrichCellValues(cells, config.responseMapping, run.master_column_name);
  const keyed = !!x.answer && reusable(x.answer);
  const dry = !!config.waterfall.dry;
  let written = false;
  db.transaction(() => {
    if (shouldStopHttpRun(run.id, x.generation)) return;
    db.prepare(`
      INSERT INTO http_results (id, run_id, user_id, row_index, request_config, response_data, extracted_fields,
        status, error_message, cost_usd, reuse_key, answered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, row_index) DO UPDATE SET
        request_config = excluded.request_config, response_data = excluded.response_data,
        extracted_fields = excluded.extracted_fields, status = excluded.status,
        error_message = excluded.error_message, cost_usd = excluded.cost_usd, reuse_key = excluded.reuse_key,
        answered_at = excluded.answered_at, updated_at = datetime('now')
    `).run(
      uuidv4(), run.id, run.user_id, x.row.rowIndex, JSON.stringify({ waterfall: true, row_id: x.row.rowId }),
      JSON.stringify(stored(trace, x.answer)), JSON.stringify(values), cells.status,
      cells.reason?.slice(0, 500) ?? null, traceCostUsd(trace),
      ...(keyed ? [x.answer!.reuseKey, answerTime(nowDate())] : [null, null]),
    );
    if (x.answer?.from === 'reused') noteReusedRow(run.id, run.user_id);
    tally(run, config, x.trace);
    if (!dry) {
      writeRowColumns(run.id, run.sheet_id, run.user_id, x.row.rowIndex, Object.entries(values), x.row.stamp);
      touchSheet(run.sheet_id, run.user_id);
      dropRowAnswers(run.user_id, x.scope, x.rowRef);
      const paidSteps = rowSteps(config).filter(s => s.choices.kind === 'enrichment' || s.choices.kind === 'ai'
        || s.check?.built.kind === 'verify');
      keepForRetry(run.user_id, x.row.rowId, run.id, paidSteps.map(s => s.id), cells.status === 'failed' ? x.kept : []);
    }
    written = true;
  }).immediate();
  return written;
}
