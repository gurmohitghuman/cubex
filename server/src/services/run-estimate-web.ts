// The web search half of estimate_only (run-estimate.ts). Which engine the
// searches would run on and at what price is the plan a run would store
// (lib/web-search-plan.ts); how many searches a row runs comes from your runs
// with the same setup, else from the cap or the engine's usual stop.
import { roundUsd } from '../lib/ai-cost';
import { defaultSearchesPerRow, fetchWork, type Range, type RowWebWork, type WebTools } from '../lib/ai-web-cost';
import { hasFetchLimits, type FetchLimits } from '../lib/web-fetch-options';
import { fetchesNatively } from './web-fetch-catalog';
import { webSearchSummary, type SearchPlan } from '../lib/web-search-plan';
import type { SearchOptions } from '../lib/web-search-options';
import { formatSearchUsd } from '../lib/web-search-pricing';
import { searchHistory } from './ai-token-history';
import { planIfSearching } from './web-search-catalog';

export interface WebEstimate {
  plan: SearchPlan | null;           // null without search, or without a model to plan for
  work: RowWebWork;
  searchesFromHistory: boolean;
  // What rows of your runs with the same setup cost, all in (null: too few).
  measuredCostPerRow: Range | null;
  // With web fetch and a page or token limit: the pages go through Exa (lib/ai-web-tools.ts).
  fetchLimited?: boolean;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const usdRange = (r: Range): Range => ({ low: roundUsd(r.low), high: roundUsd(r.high) });
// "$0.001 a row", or "$0.0012-$0.0018 a row" when the ends differ.
const usdText = (r: Range): string => {
  const [low, high] = [formatSearchUsd(roundUsd(r.low)), formatSearchUsd(roundUsd(r.high))];
  return low === high ? low : `${low}-${high}`;
};

// With web fetch: its pages, the tokens they add and their price (lib/ai-web-cost.ts fetchWork).
export async function estimateWebWork(
  userId: string, model: string | null, web: WebTools, search: SearchOptions | null | undefined,
  fetchLimits?: FetchLimits | null,
): Promise<{ ok: WebEstimate } | { error: string }> {
  const out = await searchWork(userId, model, web, search);
  if ('error' in out || !web.fetch) return out;
  const native = !!model && !hasFetchLimits(fetchLimits) && await fetchesNatively(userId, model);
  return { ok: {
    ...out.ok, work: { ...out.ok.work, ...fetchWork(fetchLimits, native) }, fetchLimited: hasFetchLimits(fetchLimits),
  } };
}

async function searchWork(
  userId: string, model: string | null, web: WebTools, search: SearchOptions | null | undefined,
): Promise<{ ok: WebEstimate } | { error: string }> {
  const none = { plan: null, searchesFromHistory: false, measuredCostPerRow: null };
  if (!web.search) return { ok: { ...none, work: { searches: null, pricePerSearch: null, fetch: web.fetch } } };
  if (!model) {
    const searches = defaultSearchesPerRow(search?.maxPerRow ?? null, false);
    return { ok: { ...none, work: { searches, pricePerSearch: null, fetch: web.fetch } } };
  }
  const planned = await planIfSearching(userId, model, true, search);
  if ('error' in planned) return planned;
  const plan = planned.ok!;
  const history = searchHistory(userId, model, { used: plan.used, mode: plan.mode, maxPerRow: plan.maxPerRow, fetch: web.fetch });
  const cap = plan.maxPerRow;
  const searches = history.searches
    ? { low: history.searches.low, high: cap !== null ? Math.min(cap, history.searches.high) : history.searches.high }
    : defaultSearchesPerRow(cap, plan.used === 'native');
  return {
    ok: {
      plan, searchesFromHistory: !!history.searches, measuredCostPerRow: history.costPerRow,
      work: { searches, pricePerSearch: plan.pricePerSearch, fetch: web.fetch },
    },
  };
}

// The estimate's web_search block: the plan, searches a row and what they cost.
export function webSearchEstimate(w: WebEstimate) {
  if (!w.plan || !w.work.searches) return null;
  const s = w.work.searches;
  const price = w.work.pricePerSearch;
  return {
    ...webSearchSummary(w.plan),
    searches_per_row: { low: round1(s.low), high: round1(s.high) },
    // history: your runs with the same settings; limit: the per-row limit; typical: no limit, the usual count.
    searches_basis: w.searchesFromHistory ? 'history' : w.plan.maxPerRow !== null ? 'limit' : 'typical',
    search_fees_per_row_usd: price !== null ? usdRange({ low: s.low * price, high: s.high * price }) : null,
    measured_cost_per_row_usd: w.measuredCostPerRow ? usdRange(w.measuredCostPerRow) : null,
  };
}

// What the estimate's note says about web fees.
export function webNote(w: WebEstimate, fees: Range, inputFromHistory: boolean): string {
  const parts: string[] = [];
  if (w.plan) parts.push(w.plan.note);
  const s = w.work.searches;
  if (s) {
    const n = s.low === s.high ? `${round1(s.low)}` : `${round1(s.low)}-${round1(s.high)}`;
    const why = w.searchesFromHistory ? 'as in your past runs with these settings'
      : w.plan?.maxPerRow != null ? 'up to the limit' : 'the usual count without a limit';
    parts.push(`Priced at ${n} search${s.high === 1 ? '' : 'es'} a row, ${why}.`);
  }
  if (w.plan && w.plan.pricePerSearch === null) {
    parts.push(w.measuredCostPerRow
      ? 'The search price is unknown, so the cost comes from what your past runs with these settings really cost.'
      : 'The search fees are left out because their price is unknown: run preview_rows to measure them.');
  }
  if (w.measuredCostPerRow && w.plan?.pricePerSearch !== null) {
    parts.push(`Your past runs with these settings cost ${usdText(w.measuredCostPerRow)} a row.`);
  }
  if (w.work.fetch) {
    parts.push(w.work.fetchPricePerPage === null
      ? "This model's provider reads pages itself, at a price it sets and OpenRouter passes on, so web fetch fees "
        + 'are left out: run preview_rows to measure them.'
      : w.fetchLimited ? 'With a page or token limit the pages are read through Exa, at $0.001 a page.'
        : 'Web fetch fees are about $0.001 a page read.');
  }
  parts.push(`Web fees come to about ${usdText(fees)} a row, plus `
    + (inputFromHistory ? 'the pages read, sized from your past runs with the same web tools.'
      : 'a rough allowance for the text the pages add to each prompt.'));
  return parts.join(' ');
}
