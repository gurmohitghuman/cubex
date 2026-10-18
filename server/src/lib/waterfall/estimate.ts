// A waterfall's cost per row (pure): the most a row can cost (every on step
// runs and pays its cap, as when no step answers) and what a row costs on
// average. A step is reached only by the rows the steps before it didn't
// answer, so the average is the sum over steps of (share of rows reaching it)
// x (what it costs when reached). Answer rates come from this column's earlier
// runs when they reached the step often enough, else from treg's observed hit
// rate; a step whose rate isn't known counts as never answering, so the
// average errs high, never low.
import { billsMisses, enabledProviders, type ProviderPick } from '../enrich-estimate';
import type { EnrichTool } from '../enrich-tool';

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

export type RateFrom = 'history' | 'treg' | null;

export interface StepCost {
  maxUsd: number;           // the most one call can cost
  expectedUsd: number;      // what it costs on average when a row reaches it
  answerRate: number | null;
  rateFrom: RateFrom;
}

export interface StepEstimate extends StepCost { id: string; reach: number }
export interface RowEstimate { avgUsd: number; maxUsd: number; steps: StepEstimate[] }

export function rowEstimate(steps: ReadonlyArray<StepCost & { id: string }>): RowEstimate {
  let reach = 1, avg = 0, max = 0;
  const out: StepEstimate[] = [];
  for (const s of steps) {
    out.push({ ...s, reach: round6(reach) });
    avg += reach * Math.min(s.expectedUsd, s.maxUsd);
    max += s.maxUsd;
    reach *= 1 - clamp01(s.answerRate ?? 0);
  }
  return { avgUsd: round6(avg), maxUsd: round6(max), steps: out };
}

// An enrichment tool's cost when a row reaches it, from treg's catalog: a
// treg waterfall walks its providers in order until one finds (or only the
// first with stop-at-first), a provider billing a miss costs its price each
// time it's asked, one billing a hit costs its price times its hit rate. A
// provider with no observed hit rate is priced as if it bills every time and
// never finds.
export function enrichmentStepCost(tool: EnrichTool, pick: ProviderPick, capUsd: number | null): StepCost {
  const cap = capUsd ?? 0;
  const observed = tool.observed.hitRate;
  if (tool.kind !== 'waterfall' || !tool.providers?.length) {
    const unit = Math.max(tool.price.usd ?? 0, tool.price.overflowUsd ?? 0);
    const perHit = tool.price.type === 'per_success' && observed !== null;
    return {
      maxUsd: cap, expectedUsd: round6(Math.min(cap, perHit ? unit * observed : unit)),
      answerRate: observed, rateFrom: observed === null ? null : 'treg',
    };
  }
  const order = (pick.order ?? []).map(s => s.toLowerCase());
  const rank = (p: string) => { const i = order.indexOf(p.toLowerCase()); return i === -1 ? order.length : i; };
  const enabled = [...enabledProviders(tool, pick)].sort((a, b) => rank(a.provider) - rank(b.provider));
  let reach = 1, expected = 0;
  for (const p of enabled) {
    const usd = p.usd ?? 0;
    const hit = p.hitRate === null ? 0 : clamp01(p.hitRate);
    expected += reach * (billsMisses(p) || p.hitRate === null ? usd : usd * hit);
    reach *= 1 - hit;
  }
  const fromProviders = enabled.some(p => p.hitRate !== null) ? 1 - reach : null;
  const answerRate = observed ?? fromProviders;
  return {
    maxUsd: cap, expectedUsd: round6(Math.min(cap, expected)), answerRate,
    rateFrom: answerRate === null ? null : 'treg',
  };
}

// A check after the step: it's paid on each value the step finds (the
// column's own share found when its runs have one, else the step's answer
// rate, else every row), and until the column's runs say how often values
// pass it, the step counts as never answering (the average errs high).
export function withCheck(
  cost: StepCost, check: { usd: number; preRate: number | null; found: number | null } | null,
): StepCost {
  if (!check) return cost;
  const found = clamp01(check.found ?? check.preRate ?? 1);
  return {
    ...cost, maxUsd: round6(cost.maxUsd + check.usd), expectedUsd: round6(cost.expectedUsd + found * check.usd),
    ...(cost.rateFrom === 'history' ? {} : { answerRate: null, rateFrom: null }),
  };
}

// An earlier runs' rate replaces the catalog's once enough rows reached the step.
export function withHistory(cost: StepCost, history: { reached: number; answered: number } | null,
  minRows: number): StepCost {
  if (!history || history.reached < minRows) return cost;
  return { ...cost, answerRate: clamp01(history.answered / history.reached), rateFrom: 'history' };
}
