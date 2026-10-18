// A formula step of a waterfall row, and the check run on a value a step
// found. A formula step works out its formula on the row's inputs (free); its
// result counts when it reads as the result type. A check is treg's email
// verify (the same tool and verdicts as the "Verified work email" loop,
// services/enrich-verified-email.ts, under its own ledger attempt so a resume
// replays it free) accepted by the step's strategy, or a formula over
// {{value}} and the inputs whose truthy result passes. A value that fails is
// rejected and the waterfall goes on; a check that couldn't run fails the step.
import { buildRequest } from '../lib/enrich-request';
import { acceptedBy, classifyVerify, statusLabel, type EmailVerdict } from '../lib/enrich-email-status';
import { waterfallOutcome } from '../lib/enrich-outcome';
import { normalizeResult } from '../lib/waterfall/result-type';
import { traceDetail, traceValue } from '../lib/waterfall/trace';
import type { BuiltFormula, WaterfallBlock, WaterfallStep } from '../lib/waterfall/config';
import { runStep, type RunCtx } from './enrich-step';
import { formulaPasses, type RunFormulas } from './waterfall-formulas';
import { STOP, type StepRun } from './waterfall-step-types';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

export async function formulaStep(a: {
  w: WaterfallBlock; stepId: string; built: BuiltFormula; inputs: Record<string, string>; formulas: RunFormulas;
}): Promise<StepRun> {
  const values = a.built.compiled.inputs.map(k => a.inputs[k] ?? '');
  const o = await a.formulas.run(`step:${a.stepId}`, a.built.compiled, values);
  if (!o.ok) return { outcome: 'error', value: '', detail: traceDetail(o.error), costUsd: 0 };
  const value = normalizeResult(a.w.resultType, o.value, a.w.phone);
  if (value) return { outcome: 'answered', value, costUsd: 0 };
  return { outcome: 'not_found', value: '', costUsd: 0, ...(o.value.trim() ? { got: traceValue(o.value) } : {}) };
}

export interface CheckResult {
  outcome: 'passed' | 'failed' | 'error';
  verdict?: string;               // the verifier's word, or the formula's result
  emailVerdict?: EmailVerdict;    // a verify's verdict, for another step's check on the same address
  detail?: string;
  costUsd: number;
}

export async function runCheck(a: {
  ctx: RunCtx; step: WaterfallStep; value: string; inputs: Record<string, string>;
  row: { rowIndex: number; rowId: string }; formulas: RunFormulas; fresh: boolean;
}): Promise<CheckResult | typeof STOP> {
  const check = a.step.check;
  if (!check) return { outcome: 'passed', costUsd: 0 };
  if (check.built.kind === 'formula') {
    const values = check.built.compiled.inputs.map(k => (k === 'value' ? a.value : a.inputs[k] ?? ''));
    const o = await a.formulas.run(`check:${a.step.id}`, check.built.compiled, values);
    if (!o.ok) return { outcome: 'error', detail: traceDetail(o.error), costUsd: 0 };
    return { outcome: formulaPasses(o.value) ? 'passed' : 'failed', verdict: traceValue(o.value), costUsd: 0 };
  }
  const b = check.built;
  const accept = check.choices.kind === 'verify' ? check.choices.accept : 'safest';
  const built = buildRequest(b.tool, { email: a.value }, {}, { cleanDomains: false, columns: [] });
  // An address the verify can't take, now or on a retry: the value fails its check.
  if (!built.ok) return { outcome: 'failed', verdict: "the verify can't take this address", costUsd: 0 };
  const parts = {
    method: built.method, path: built.path, query: built.query, body: built.body, prefer: [], exclude: b.exclude,
  };
  const r = await runStep(a.ctx, {
    toolId: b.tool.id, attempt: `w${a.step.id}.c1`, rowIndex: a.row.rowIndex, rowId: a.row.rowId, parts,
    sameKey: `${a.step.id}:check`,
    request: { ...parts, routed: b.toolKind === 'waterfall', maxCostUsd: b.capUsd, stopAtFirst: false, fresh: a.fresh },
  });
  const costUsd = r.costMicro / 1e6;
  if (r.kind === 'answer') {
    const out = isObj(r.body) && isObj(r.body.output) ? r.body.output : null;
    const heard = b.toolKind !== 'waterfall' || waterfallOutcome(r.body, r.meta) === 'hit';
    const { verdict, word } = heard ? classifyVerify(out) : { verdict: 'no_verdict' as const, word: null };
    const outcome = acceptedBy(accept, verdict) ? 'passed' : 'failed';
    return { outcome, verdict: word ?? statusLabel(verdict), emailVerdict: verdict, costUsd };
  }
  // treg declined the check for good (no route, missing input, over its cap): the value fails it.
  // A failure a retry can fix (treg out of reach, a provider error) is the check's error.
  if (r.kind === 'row_skip') return { outcome: 'failed', verdict: traceValue(r.message), costUsd };
  if (r.kind === 'row_fail') return { outcome: 'error', detail: traceDetail(r.message), costUsd };
  // pause, fail_run (ctx.halt is set) or stopped: the row ends without writing.
  return STOP;
}
