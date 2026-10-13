// Cost guards and estimates for an enrichment run (pure).
//
// treg's X-Treg-Route-Max-Cost is cumulative for a whole waterfall: a provider
// is skipped once spent-so-far plus its price would pass it (route.py). So the
// default per-row cap must cover every enabled provider that bills a miss, plus
// the dearest one that could answer, or the waterfall quietly stops early.
import { ENRICH_MAX_DEFAULT_ROW_CAP_USD } from './constants';
import { providerCanAnswer } from './enrich-accepts';
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

// What the user picked for a waterfall: providers switched off, the inputs
// they mapped (null: don't filter by inputs), their order, and "stop after the
// first provider" (X-Treg-Route-Waterfall: 0). limit is a page size.
export interface ProviderPick {
  skip?: string[]; given?: string[] | null; order?: string[]; stopAtFirst?: boolean; limit?: number | null;
}

// The providers a row can reach: switched on, usable in a sheet, with an
// identity the mapped inputs cover. With stop-at-first, only the first of them
// in the user's order (catalog order for the rest).
export function enabledProviders(tool: EnrichTool, pick: ProviderPick = {}): ToolProvider[] {
  const skipped = new Set((pick.skip ?? []).map(s => s.toLowerCase()));
  const sent = pick.given ? new Set(pick.given) : null;
  const known = new Set((tool.inputs ?? []).map(i => i.name));
  const usable = (tool.providers ?? []).filter(p => !p.exhausted && !p.unavailable
    && !skipped.has(p.provider.toLowerCase())
    && (!sent || providerCanAnswer(p.accepts, sent, tool.derive, known)));
  if (!pick.stopAtFirst || usable.length === 0) return usable;
  const order = (pick.order ?? []).map(s => s.toLowerCase());
  const rank = (p: ToolProvider) => {
    const i = order.indexOf(p.provider.toLowerCase());
    return i === -1 ? order.length : i;
  };
  return [[...usable].sort((a, b) => rank(a) - rank(b))[0]];
}

// One call to a single tool: its price, times the page size for per-result
// pricing (treg reserves 20 rows when no limit is sent). Overflow pricing (an
// aggregator serving when treg's own account is out) counts as the worst case.
function singleCallCost(tool: EnrichTool, limit: number | null): number {
  const unit = Math.max(tool.price.usd ?? 0, tool.price.overflowUsd ?? 0);
  return tool.price.type === 'per_result' ? unit * Math.min(Math.max(limit ?? 20, 1), 100) : unit;
}

// A waterfall whose plan is known but leaves no provider a row can reach
// (inputs, switches): nothing would be called, so nothing is priced.
const noneOf = (tool: EnrichTool, enabled: ToolProvider[]) =>
  tool.kind === 'waterfall' && tool.providers !== null && enabled.length === 0;
export function noProviderCanRun(tool: EnrichTool, opts: ProviderPick = {}): boolean {
  return noneOf(tool, enabledProviders(tool, opts));
}

// Waterfall: every provider that bills a miss, plus the dearest one that only
// charges on a hit (a miss-billing provider is already in the sum), capped at
// treg's own $1 waterfall default. A single tool's default is simply its price.
// A waterfall with no provider to run costs nothing; one whose plan the catalog
// didn't list falls back to its list price.
export function defaultMaxCostPerRow(tool: EnrichTool, opts: ProviderPick = {}): number {
  const enabled = enabledProviders(tool, opts);
  if (noneOf(tool, enabled)) return 0;
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
export function estimateRun(tool: EnrichTool, rows: number, maxCostPerRow: number, opts: ProviderPick = {}): Estimate {
  const enabled = enabledProviders(tool, opts);
  if (noneOf(tool, enabled)) return { rows, lowUsd: 0, highUsd: 0, perRowLowUsd: 0, perRowHighUsd: 0 };
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

// Whether a limit leaves no room for one more row. A run with no per-row cap
// (null: the catalog listed no price, so the team's own provider key should
// bill it) sends treg no X-Treg-Route-Max-Cost, and nothing stops treg billing
// a call after all (it prices the tool now, or serves it on its own key): what
// treg really charged stops that run, once it reaches the limit.
export function limitReached(limitUsd: number | null, spentUsd: number, maxCostPerRow: number | null): boolean {
  if (limitUsd === null) return false;
  if (maxCostPerRow === null) return spentUsd + EPS >= limitUsd;
  return rowsThatFit(limitUsd, spentUsd, maxCostPerRow) < 1;
}

// What such a run's pause says, after which limit it reached.
export const UNCAPPED_BILLED_NOTE = 'This tool usually bills your own provider key, but what treg charges counts too.';
