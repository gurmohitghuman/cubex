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
import { DRY_SCOPE, findKeptAnswer, keepAnswer } from './waterfall-journal';
import { keepableForRetry, keptForRetry, type KeptStep, type RetryKept } from './waterfall-retry-kept';
import { STOP, type StepResult, type StepRun } from './waterfall-step-types';
import { formulaStep } from './waterfall-step-check';
import { checkValue, type RowVerdicts } from './waterfall-row-check';
import type { RunFormulas } from './waterfall-formulas';
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
  halt: (message: string, reason?: string) => void;   // an AI account problem, a formula too slow
  allowSavedKeys: boolean;
  columns: () => string[];            // the sheet's column registry, read at most once a second
  formulas: RunFormulas;              // formula steps and checks, opened once for the run
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
  if (ch.kind === 'formula' && step.built.kind === 'formula') {
    return formulaStep({ w, stepId: step.id, built: step.built, inputs, formulas: c.formulas });
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
  const kept: RetryKept[] = [];
  const verdicts: RowVerdicts = new Map();
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
    if (!r && retryFailed && (paid || step.check?.built.kind === 'verify')) {
      // A paid miss, or a value its check rejected or couldn't run on: the check runs again
      // below (a verify from its kept verdict, at $0).
      const last = keptForRetry(userId, row.rowId, step.id, stepKey);
      if (last) {
        const k: KeptStep = last.kept;
        r = {
          outcome: k.outcome, value: k.value, costUsd: 0, from: 'last_run',
          ...(k.got ? { got: k.got } : {}), ...(k.provider ? { provider: k.provider } : {}),
        };
        if (k.verdict && k.value) verdicts.set(k.value.toLowerCase(), k.verdict);
        since = last.since;
      }
    }
    if (!r) {
      const res = await callStep(c, step, row, inputs);
      if (res === STOP) return false;
      r = res;
      // AI and HTTP answers are kept for this run's resume; a dry run keeps
      // its paid steps' (treg, AI) for any later run of the same step on the
      // same inputs. An AI call's cost goes on the run now.
      const kind = step.choices.kind;
      const ai = kind === 'ai';
      const keep = !r.from && (dry ? paid : ai || kind === 'http');
      if (ai || keep) {
        // A dry run's answers are replayed without their treg body (its own result row keeps that).
        const body = dry ? undefined : keptBody(r);
        keepAnswer({ userId, scope, rowRef, stepKey }, c.run.id, { ...r, body }, { ai, keep });
      }
    }
    let t = traceOf(step, r, 0);
    // A value with a check counts only once the check passes; otherwise it's rejected and the waterfall goes on.
    if (r.outcome === 'answered' && step.check) {
      const checked = await checkValue(c, step, r.value, row, inputs, verdicts);
      if (checked === STOP) return false;
      const { detail, ...check } = checked;
      t = { ...t, check };
      // A failed check rejects the value (its verdict says why); one that couldn't run fails
      // the step, so "Retry failed rows" runs the check again on the kept value.
      if (check.outcome === 'failed') t = { ...t, outcome: 'rejected' };
      if (check.outcome === 'error') {
        t = { ...t, outcome: 'error', detail: traceDetail(detail ?? "Its check couldn't run.") };
      }
    }
    trace.push({ ...t, ms: Date.now() - started });
    const keep = keepableForRetry(step, r, t, paid, r.value ? verdicts.get(r.value.toLowerCase()) : undefined);
    if (keep) kept.push({ stepId: step.id, stepKey, kept: keep, ...(since ? { since } : {}) });
    if (t.outcome === 'answered') {
      answer = {
        stepId: step.id, from: r.from ?? null, body: keptBody(r), reuseKey: r.reuseKey ?? null, routed: !!r.routed,
      };
      break;
    }
  }
  if (c.stopped()) return false;
  return writeWaterfallRow({
    run: c.run, config: c.config, generation: c.generation, row, trace, answer, scope, rowRef, kept,
  });
}
