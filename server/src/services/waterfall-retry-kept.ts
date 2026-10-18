// What a row that ends failed keeps for "Retry failed rows", so a retry asks
// again only what failed (waterfall_step_answers, scope 'miss', row_ref = the
// row's id and the step's, so each waterfall column keeps its own; rewritten
// at each write of the row; pruned with the other kept answers): a paid step
// that found nothing, and a value the row paid for that its check rejected or
// couldn't run on. A retry replays them at $0 (keeping their first date, so
// the keep still ends) and runs only the check again: a formula check is free,
// and a verify is judged again from the kept verdict, so a changed input or
// strategy counts and nothing is bought twice.
import { db } from '../lib/db';
import { nowDate } from '../lib/clock';
import type { TraceStep } from '../lib/waterfall/trace';
import type { WaterfallStep } from '../lib/waterfall/config';
import { findKeptAnswer } from './waterfall-journal';
import type { StepRun } from './waterfall-step-types';
import type { EmailVerdict } from '../lib/enrich-email-status';

export const MISS_SCOPE = 'miss';

export interface KeptStep {
  outcome: 'not_found' | 'answered';
  value: string;                  // a value its check rejected or couldn't run on
  costUsd: number;
  got?: string;
  provider?: string;
  verdict?: { verdict: EmailVerdict; word: string | null };   // a verify's, judged again on a retry
}
export interface RetryKept { stepId: string; stepKey: string; kept: KeptStep; since?: string }

export const missRef = (rowId: string, stepId: string): string => `${rowId}:${stepId}`;

// The newest kept outcome of this step on this row (the step's settings and inputs in stepKey).
export function keptForRetry(userId: string, rowId: string, stepId: string, stepKey: string)
  : { kept: KeptStep; since: string } | null {
  const hit = findKeptAnswer({ userId, scope: MISS_SCOPE, rowRef: missRef(rowId, stepId), stepKey });
  return hit ? { kept: hit.run as unknown as KeptStep, since: hit.createdAt } : null;
}

// Call inside the row's write: for each paid step of this waterfall (stepIds),
// the row's kept outcomes become this write's (none unless the row failed).
export function keepForRetry(
  userId: string, rowId: string, runId: string, stepIds: readonly string[], kept: readonly RetryKept[],
): void {
  const drop = db.prepare('DELETE FROM waterfall_step_answers WHERE user_id = ? AND scope = ? AND row_ref = ?');
  for (const id of stepIds) drop.run(userId, MISS_SCOPE, missRef(rowId, id));
  const add = db.prepare(`INSERT INTO waterfall_step_answers (user_id, scope, row_ref, step_key, run_id, outcome,
      cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const k of kept) {
    add.run(userId, MISS_SCOPE, missRef(rowId, k.stepId), k.stepKey, runId, JSON.stringify(k.kept), k.kept.costUsd,
      k.since ?? nowDate().toISOString());
  }
}

const PAID_BEFORE = new Set(['last_run', 'journal', 'same_lookup']);

// What a retry of this row (if it fails) shouldn't pay for again: a paid miss
// (now, in an earlier batch or run, or as another row's same lookup), a value
// the row paid for (its step or its verify) that its check rejected, or a paid
// value whose check couldn't run. verdict: the row's verify verdict on it.
export function keepableForRetry(
  step: WaterfallStep, r: StepRun, t: TraceStep, paid: boolean, verdict: KeptStep['verdict'],
): KeptStep | null {
  const paidBefore = r.costUsd > 0 || (!!r.from && PAID_BEFORE.has(r.from));
  const base = {
    costUsd: r.costUsd + (t.check?.cost_usd ?? 0), ...(r.got ? { got: r.got } : {}),
    ...(r.provider ? { provider: r.provider } : {}),
  };
  if (t.outcome === 'not_found' && paid && paidBefore) return { outcome: 'not_found', value: '', ...base };
  const check = t.check;
  if (t.outcome === 'rejected' && check?.outcome === 'failed' && (paid || step.check?.built.kind === 'verify')) {
    return { outcome: 'answered', value: r.value, ...base, ...(verdict ? { verdict } : {}) };
  }
  if (t.outcome === 'error' && check?.outcome === 'error' && paid) {
    return { outcome: 'answered', value: r.value, ...base };
  }
  return null;
}
