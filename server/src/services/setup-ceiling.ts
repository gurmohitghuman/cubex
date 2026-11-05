// A setup's cost ceiling while it runs (apply_setup's max_cost_usd, checked
// against the estimate when it was applied: setup-apply.ts). The token's
// spend cap is checked before each spending step too (moved here from
// setup-runner.ts). What is left for a step: the ceiling, less what the steps
// started spent or may still spend (a run still going counts at its own
// limit, or what it spent if more), less what the steps not started yet need,
// so a step never takes their share. A step needs its estimated high end and,
// for an AI step, one row's most on top: its run's hard spend limit
// (services/ai-spend-gate.ts) starts a row only while that row's most still
// fits, so with less it would stop before its last rows. A step that no
// longer fits doesn't start: the setup pauses before it, as at the token's
// cap. Otherwise each AI step's run starts with what is left as its limit and
// an enrichment's run limit is the lower of its own and that (it pauses
// there). The high ends are the estimate's when the setup was applied (a
// later step is priced before the values it reads exist, as if each held a
// few words, so a long value can make it cost more). A step with no price
// (let in by allow_unpriced) runs without a limit: Cubex can't hold it to the
// ceiling, but what it spends counts for the steps after it. Everything is
// read from the record and the runs' usage records, so a restart changes nothing.
import { db } from '../lib/db';
import { micro, money, type CeilingFigures } from '../lib/cost-ceiling';
import type { SetupStep } from '../lib/setups/spec';
import { actorSpendRefusal } from './token-spend';
import type { SetupEstimate } from './setup-estimate';
import { planOf, type SetupRunRow, type StepRecord } from './setup-run-store';

// highUsd: each step's estimated high end when the setup was applied (0: it
// spends nothing here; null: no known price). rowMostUsd: an AI step's most
// for one row (0 for the rest; missing in a record from before it).
export interface SetupCeiling {
  maxCostUsd: number; allowUnpriced: boolean; highUsd: Array<number | null>; rowMostUsd?: number[];
}

export function setupCeilingOf(e: SetupEstimate, c: { maxCostUsd: number | null; allowUnpriced: boolean })
  : SetupCeiling {
  return {
    maxCostUsd: c.maxCostUsd ?? 0, allowUnpriced: c.allowUnpriced,
    highUsd: e.steps.map(s => (s.free || s.sends_requests ? 0 : s.high_usd)),
    rowMostUsd: e.steps.map(s => (s.free || s.sends_requests || s.high_usd === null ? 0 : s.row_most_usd ?? 0)),
  };
}

// What apply_setup's ceiling is checked against: the high ends, and one row's most for each AI step.
export function setupCeilingFigures(e: SetupEstimate): CeilingFigures {
  return {
    highUsd: e.high_usd, unpriced: e.unpriced, rowMostUsd: e.row_most_usd,
    rowMostSteps: e.steps.filter(s => s.high_usd !== null && (s.row_most_usd ?? 0) > 0).length,
  };
}

const LIVE = new Set(['pending', 'running', 'paused']);
const floor6 = (usd: number) => Math.floor(usd * 1e6 + 1e-6) / 1e6;

// What a step's run spent, or may still spend while it goes on (its own limit, when it has one).
function committedUsd(kind: 'ai' | 'http', runId: string): number {
  const spent = (db.prepare(`SELECT ai_cost_usd + provider_cost_usd + enrich_micro / 1e6 FROM run_usage
    WHERE run_id = ?`).pluck().get(runId) as number | undefined) ?? 0;
  const run = (kind === 'ai'
    ? db.prepare('SELECT status, spend_limit_usd AS lim FROM ai_runs WHERE id = ?').get(runId)
    : db.prepare(`SELECT status, CASE WHEN json_valid(config) THEN json_extract(config, '$.enrichment.spendLimitUsd')
        END AS lim FROM http_runs WHERE id = ?`).get(runId)) as { status: string; lim: number | null } | undefined;
  return run && LIVE.has(run.status) && typeof run.lim === 'number' ? Math.max(spent, run.lim) : spent;
}

// Whether step i may start now, and the limit it starts with (null: none).
// refused: why not; the runner pauses the setup with it.
export function stepGate(r: SetupRunRow, i: number, steps: StepRecord[])
  : { refused: string } | { limitUsd: number | null } {
  const plan = planOf(r), step: SetupStep = plan.spec.steps[i];
  if (step.kind !== 'ai' && step.kind !== 'enrichment') return { limitUsd: null };
  // At the setup's token's spend cap it doesn't start (it would write its placeholders only to pause).
  const capped = actorSpendRefusal(r.user_id, step.kind === 'enrichment' ? step.maxCostPerRowUsd : null);
  if (capped) return { refused: capped };
  const c = plan.ceiling;
  const high = c?.highUsd[i];
  if (!c || high === null || high === undefined) return { limitUsd: null };
  // What step j needs: its high end, and an AI step's one row at its most.
  const need = (j: number) => (c.highUsd[j] ?? 0) + (c.rowMostUsd?.[j] ?? 0);
  let committed = 0;
  for (const [j, st] of steps.entries()) {
    if (j === i) continue;
    if (st.runId && (st.kind === 'ai' || st.kind === 'http')) committed += committedUsd(st.kind, st.runId);
    else if (st.state === 'waiting' || st.state === 'starting') committed += need(j);
  }
  const left = floor6(c.maxCostUsd - committed);
  if (left > 0 && micro(high) + micro(c.rowMostUsd?.[i] ?? 0) <= micro(left)) return { limitUsd: left };
  const most = c.rowMostUsd?.[i] ? `, and its spend limit needs room for one row at its most on top `
    + `(up to ${money(c.rowMostUsd[i])})` : '';
  return {
    refused: `it could cost up to ${money(high)}${most}, and ${money(committed)} of the ${money(c.maxCostUsd)} `
      + 'ceiling is spent or held. Stop the setup, then use it again with a max_cost_usd that covers what is '
      + 'left to do: it carries on where it stopped, and the new ceiling counts only what it spends from then on.',
  };
}
