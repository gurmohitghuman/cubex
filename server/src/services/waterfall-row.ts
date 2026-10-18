// One waterfall row: its inputs read once, then each step that's on, in
// order, until one answers. A step whose required inputs the row lacks is
// skipped at no cost. Before a step is called, an answer kept for it is
// replayed at no cost: the row's own (a resume of this run), a dry run's
// (the same step on the same inputs, unless the run calls again), or on a
// retry of failed rows, what the row's last run paid to find nothing. A step that
// meets a run-level stop ends the row without writing: it keeps its ⏳ and the
// resume picks it up, its finished steps replayed from the journal.
import type OpenAI from 'openai';
import type { RunRow } from '../lib/run-rows';
import { goneColumnsOf } from '../lib/template-token-match';
import { inputMapOf, inputValues, requiresMet, requiresText } from '../lib/waterfall/inputs';
import { answerKey, settingsKey, stepReads } from '../lib/waterfall/keys';
import { rowSteps, type WaterfallRunConfig, type WaterfallStep } from '../lib/waterfall/config';
import { traceDetail, type TraceStep } from '../lib/waterfall/trace';
import { keyScope, type RunCtx } from './enrich-step';
import { enrichmentStep } from './waterfall-step-enrich';
import { httpStep } from './waterfall-step-http';
import { aiStep } from './waterfall-step-ai';
import { DRY_SCOPE, MISS_SCOPE, findKeptAnswer, keepAnswer, missRef, type PaidMiss } from './waterfall-journal';
import { STOP, type StepResult, type StepRun } from './waterfall-step-types';
import { keptBody, writeWaterfallRow, type AnswerOf } from './waterfall-row-write';
import type { HTTPRunRow } from './http-runner-status';

export interface WaterfallRowCtx {
  run: HTTPRunRow;
  config: WaterfallRunConfig;
  generation: number;
  enrich: RunCtx;                     // treg calls (its token is set before rows start)
  ai: OpenAI | null;                  // set when an AI step is on
  signal: AbortSignal;
  stopped: () => boolean;             // the run stopped, was superseded, or halted
  halt: (message: string) => void;    // an AI account problem stops the run
  allowSavedKeys: boolean;
  columns: () => string[];            // the sheet's column registry, read at most once a second
}

async function callStep(c: WaterfallRowCtx, step: WaterfallStep, row: RunRow, inputs: Record<string, string>)
  : Promise<StepResult> {
  const w = c.config.waterfall;
  const ch = step.choices;
  const fresh = w.fresh || !!w.noReuse;
  if (ch.kind === 'enrichment' && step.built.kind === 'enrichment') {
    return enrichmentStep({
      ctx: c.enrich, w, stepId: step.id, choices: ch, built: step.built,
      row: { rowIndex: row.rowIndex, rowId: row.rowId }, inputs, fresh,
    });
  }
  if (ch.kind === 'http') {
    return httpStep({
      w, choices: ch, inputs, userId: c.run.user_id, runId: c.run.id, allowSavedKeys: c.allowSavedKeys,
      signal: c.signal, stopped: c.stopped,
    });
  }
  if (ch.kind === 'ai' && step.built.kind === 'ai' && c.ai) {
    return aiStep({
      w, choices: ch, built: step.built, inputs, client: c.ai, signal: c.signal, stopped: c.stopped, halt: c.halt,
    });
  }
  return { outcome: 'error', value: '', detail: `${ch.kind} steps can't run here yet.`, costUsd: 0 };
}

function traceOf(step: WaterfallStep, r: StepRun, ms: number): TraceStep {
  return {
    id: step.id, label: step.label, kind: step.choices.kind, outcome: r.outcome,
    ...(r.value ? { value: r.value } : r.got ? { value: r.got } : {}),
    ...(r.detail ? { detail: traceDetail(r.detail) } : {}),
    ...(r.provider ? { provider: r.provider } : {}),
    cost_usd: r.costUsd, ms, ...(r.from ? { from: r.from } : {}),
  };
}

const PAID_BEFORE = new Set(['last_run', 'journal', 'same_lookup']);

// Returns whether the row's result was written.
export async function processWaterfallRow(c: WaterfallRowCtx, row: RunRow): Promise<boolean> {
  const w = c.config.waterfall;
  const dry = !!w.dry;
  const keys = w.inputs.map(i => i.key);
  const inputs = inputValues(inputMapOf(c.config), row.data, goneColumnsOf(c.config.requestConfig), keys,
    c.columns());
  const scope = dry ? DRY_SCOPE : keyScope(c.enrich, row.rowIndex, row.rowId).scope;
  const rowRef = dry ? '' : row.rowId;
  const userId = c.run.user_id;
  const trace: TraceStep[] = [];
  const misses: PaidMiss[] = [];
  // "Retry failed rows" asks again what failed, not what the row already paid to miss.
  const retryFailed = !dry && w.rows.status === 'failed' && !w.fresh && !w.noReuse;
  let answer: AnswerOf | null = null;
  for (const step of rowSteps(c.config)) {
    if (c.stopped()) return false;
    if (!requiresMet(step.requires, inputs)) {
      const detail = `Needs ${requiresText(step.requires)}.`;
      trace.push(traceOf(step, { outcome: 'no_inputs', value: '', detail, costUsd: 0 }, 0));
      continue;
    }
    const started = Date.now();
    const stepKey = answerKey(settingsKey(w, step), stepReads(step, keys), inputs);
    let r: StepRun | null = null;
    // The row's own answer (this run, or an earlier one of an auto-run that put the row back).
    const own = dry ? null : findKeptAnswer({ userId, scope, rowRef, stepKey });
    if (own) r = { ...own.run, from: 'journal', ...(own.runId === c.run.id ? {} : { costUsd: 0, body: undefined }) };
    if (!r && !w.fresh && !w.noReuse) {
      const kept = findKeptAnswer({ userId, scope: DRY_SCOPE, rowRef: '', stepKey });
      if (kept) r = { ...kept.run, from: 'dry_run', costUsd: 0, aiProviderUsd: 0, body: undefined };
    }
    const paid = step.choices.kind === 'enrichment' || step.choices.kind === 'ai';
    let since: string | undefined;
    if (!r && retryFailed && paid) {
      const last = findKeptAnswer({ userId, scope: MISS_SCOPE, rowRef: missRef(row.rowId, step.id), stepKey });
      if (last?.run.outcome === 'not_found') {
        r = { ...last.run, from: 'last_run', costUsd: 0, aiProviderUsd: 0, body: undefined };
        since = last.createdAt;
      }
    }
    if (!r) {
      const res = await callStep(c, step, row, inputs);
      if (res === STOP) return false;
      r = res;
      // AI and HTTP answers are kept for a replay (a dry run keeps every
      // step's, for the real run); an AI call's cost goes on the run now.
      const kind = step.choices.kind;
      const ai = kind === 'ai';
      const keep = !r.from && (dry || ai || kind === 'http');
      if (ai || keep) {
        keepAnswer({ userId, scope, rowRef, stepKey }, c.run.id, { ...r, body: keptBody(r) }, { ai, keep });
      }
    }
    trace.push(traceOf(step, r, Date.now() - started));
    // A miss this row paid for: now, in an earlier batch or run (kept), or as another row's same lookup.
    if (paid && r.outcome === 'not_found' && (r.costUsd > 0 || (r.from && PAID_BEFORE.has(r.from)))) {
      misses.push({ stepId: step.id, stepKey, run: r, ...(since ? { since } : {}) });
    }
    if (r.outcome === 'answered') {
      answer = {
        stepId: step.id, from: r.from ?? null, body: keptBody(r), reuseKey: r.reuseKey ?? null, routed: !!r.routed,
      };
      break;
    }
  }
  if (c.stopped()) return false;
  return writeWaterfallRow({
    run: c.run, config: c.config, generation: c.generation, row, trace, answer, scope, rowRef, misses,
  });
}
