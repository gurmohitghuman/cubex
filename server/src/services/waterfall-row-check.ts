// The check on a value a waterfall step found (services/waterfall-step-check.ts),
// as a row runs it. An address this row's verify already judged is judged
// again from that verdict with this step's strategy, at $0 (two steps often
// find the same address). A value a dry run checked the same way is replayed
// at $0 (unless the run calls again; a dry run replays an earlier dry run's
// too), else the check runs; a dry run keeps a verify it bought, so the real
// run doesn't pay for it twice.
import { acceptedBy, statusLabel, type EmailVerdict } from '../lib/enrich-email-status';
import { checkKey } from '../lib/waterfall/keys';
import type { TraceStep } from '../lib/waterfall/trace';
import type { WaterfallStep } from '../lib/waterfall/config';
import { DRY_SCOPE, findKeptAnswer, keepAnswer } from './waterfall-journal';
import { runCheck, type CheckResult } from './waterfall-step-check';
import { STOP, type StepRun } from './waterfall-step-types';
import type { WaterfallRowCtx } from './waterfall-row';

export type CheckedValue = NonNullable<TraceStep['check']> & { detail?: string };
// A row's verify verdicts, by address (lower case).
export type RowVerdicts = Map<string, { verdict: EmailVerdict; word: string | null }>;

export async function checkValue(
  c: WaterfallRowCtx, step: WaterfallStep, value: string, row: { rowIndex: number; rowId: string },
  inputs: Record<string, string>, verdicts: RowVerdicts,
): Promise<CheckedValue | typeof STOP> {
  const w = c.config.waterfall;
  const dry = !!w.dry;
  const fresh = w.fresh || !!w.noReuse;
  const accept = step.check?.choices.kind === 'verify' ? step.check.choices.accept : null;
  const address = value.toLowerCase();
  const known = accept ? verdicts.get(address) : undefined;
  if (accept && known) {
    const outcome = acceptedBy(accept, known.verdict) ? 'passed' : 'failed';
    return { outcome, verdict: known.word ?? statusLabel(known.verdict), cost_usd: 0 };
  }
  const key = checkKey(step, value, inputs);
  const ref = key ? { userId: c.run.user_id, scope: DRY_SCOPE, rowRef: '', stepKey: key } : null;
  if (ref && !fresh) {
    const kept = findKeptAnswer(ref)?.run as unknown as CheckResult | undefined;
    if (kept && (kept.outcome === 'passed' || kept.outcome === 'failed')) {
      if (accept && kept.emailVerdict) {
        verdicts.set(address, { verdict: kept.emailVerdict, word: kept.verdict ?? null });
      }
      const verdict = kept.verdict ? { verdict: kept.verdict } : {};
      return { outcome: kept.outcome, ...verdict, cost_usd: 0, from: 'dry_run' };
    }
  }
  const r = await runCheck({ ctx: c.enrich, step, value, inputs, row, formulas: c.formulas, fresh });
  if (r === STOP) return STOP;
  if (r.emailVerdict) verdicts.set(address, { verdict: r.emailVerdict, word: r.verdict ?? null });
  if (ref && dry && step.check?.built.kind === 'verify' && r.outcome !== 'error') {
    keepAnswer(ref, c.run.id, r as unknown as StepRun, { ai: false, keep: true });
  }
  return {
    outcome: r.outcome, ...(r.verdict ? { verdict: r.verdict } : {}), cost_usd: r.costUsd,
    ...(r.detail ? { detail: r.detail } : {}),
  };
}
