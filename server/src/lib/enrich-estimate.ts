// Cost guards and estimates for an enrichment run (pure).
//
// treg's X-Treg-Route-Max-Cost is cumulative for a whole waterfall: a provider
// is skipped once spent-so-far plus its price would pass it (route.py). So the
// default per-row cap must cover every enabled provider that bills a miss, plus
// the dearest one that could answer, or the waterfall quietly stops early.
import { ENRICH_MAX_DEFAULT_ROW_CAP_USD } from './constants';
import type { EnrichTool, ToolProvider } from './enrich-tool';

const EPS = 1e-9;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

// per_success providers cost only on a hit (price per hit == price); per_call
// and per_result ones cost on every call, so their price per hit is higher.
// No observed price per hit yet: assume it bills misses (the safe side).
export function billsMisses(p: ToolProvider): boolean {
  if (!p.usd) return false;
  return p.usdPerHit === null || p.usdPerHit > p.usd + EPS;
}

export function enabledProviders(tool: EnrichTool, skip: string[] = []): ToolProvider[] {
  const skipped = new Set(skip.map(s => s.toLowerCase()));
  return (tool.providers ?? []).filter(p => !p.exhausted && !skipped.has(p.provider.toLowerCase()));
}

// One call to a single tool: its price, times the page size for per-result
// pricing (treg reserves 20 rows when no limit is sent). Overflow pricing (an
// aggregator serving when treg's own account is out) counts as the worst case.
function singleCallCost(tool: EnrichTool, limit: number | null): number {
  const unit = Math.max(tool.price.usd ?? 0, tool.price.overflowUsd ?? 0);
  return tool.price.type === 'per_result' ? unit * Math.min(Math.max(limit ?? 20, 1), 100) : unit;
}

// Waterfall: every provider that bills a miss, plus the dearest one that only
// charges on a hit (a miss-billing provider is already in the sum), capped at
// treg's own $1 waterfall default. A single tool's default is simply its price.
export function defaultMaxCostPerRow(tool: EnrichTool, opts: { skip?: string[]; limit?: number | null } = {}): number {
  const enabled = enabledProviders(tool, opts.skip);
  if (tool.kind === 'waterfall' && enabled.length) {
    const misses = enabled.filter(billsMisses).reduce((s, p) => s + (p.usd ?? 0), 0);
    const dearestOnHit = enabled.filter(p => !billsMisses(p)).reduce((m, p) => Math.max(m, p.usd ?? 0), 0);
    return round6(Math.min(misses + dearestOnHit, ENRICH_MAX_DEFAULT_ROW_CAP_USD));
  }
  return round6(singleCallCost(tool, opts.limit ?? null));
}

// Verified work email: up to a few finds plus checks per row.
export function defaultEmailLoopCap(findCap: number, verifyCap: number): number {
  return round6(Math.min(2 * findCap + 3 * verifyCap, ENRICH_MAX_DEFAULT_ROW_CAP_USD));
}

export interface Estimate { rows: number; lowUsd: number; highUsd: number; perRowLowUsd: number; perRowHighUsd: number }

// Low: every row found by the cheapest enabled provider. High: every row
// spends its whole cap. Rows nobody finds can be free with per-success
// providers, so the real figure is usually near the low end.
export function estimateRun(tool: EnrichTool, rows: number, maxCostPerRow: number, opts: { skip?: string[]; limit?: number | null } = {}): Estimate {
  const enabled = enabledProviders(tool, opts.skip);
  const cheapest = tool.kind === 'waterfall' && enabled.length
    ? enabled.reduce((m, p) => Math.min(m, p.usd ?? 0), Infinity)
    : singleCallCost(tool, opts.limit ?? null);
  const perRowLow = Math.min(Number.isFinite(cheapest) ? cheapest : 0, maxCostPerRow);
  return {
    rows,
    lowUsd: round6(rows * perRowLow),
    highUsd: round6(rows * maxCostPerRow),
    perRowLowUsd: round6(perRowLow),
    perRowHighUsd: round6(maxCostPerRow),
  };
}

// How many rows the next batch may start without passing a spend limit:
// limit minus what's spent, divided by the per-row cap. Infinity when a row
// can't cost anything (cap 0) or there is no limit.
export function rowsThatFit(limitUsd: number | null, spentUsd: number, maxCostPerRow: number): number {
  if (limitUsd === null || maxCostPerRow <= 0) return Infinity;
  return Math.max(0, Math.floor((limitUsd - spentUsd + EPS) / maxCostPerRow));
}
