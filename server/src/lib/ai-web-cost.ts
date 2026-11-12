// What web search and web fetch add to one row of an AI run, for estimate_only:
// the provider fees, and the input tokens the found or fetched text adds to the
// prompt. Pure (constants-ai.ts holds the numbers and where they come from; a
// search's price comes from the run's plan, lib/web-search-plan.ts).
import {
  WEB_FETCH_USD_PER_PAGE, WEB_FETCH_PAGES_PER_ROW, WEB_SEARCH_TOKENS_PER_SEARCH, WEB_FETCH_TOKENS_PER_PAGE,
  WEB_SEARCHES_PER_ROW, WEB_SEARCHES_PER_ROW_NATIVE,
} from './constants-ai';
import { hasFetchLimits, type FetchLimits } from './web-fetch-options';

export interface Range { low: number; high: number }
export interface WebTools { search: boolean; fetch: boolean }

// A row's web work: how many searches it runs (null without search) at what
// price each (null when the provider's price is unknown), and whether it
// fetches; with fetch, the pages it reads, the tokens each adds and the price
// of a page (null: unknown), when they differ from the defaults (fetchWork).
export interface RowWebWork {
  searches: Range | null; pricePerSearch: number | null; fetch: boolean;
  fetchPages?: Range; fetchTokensPerPage?: Range; fetchPricePerPage?: number | null;
}

const capped = (r: Range, cap: number | null): Range =>
  (cap === null ? r : { low: Math.min(r.low, cap), high: Math.min(r.high, cap) });

// What a run's fetch limits change: no more pages than the page limit, no more
// tokens a page than the token limit. With a limit the pages are read through
// Exa (lib/ai-web-tools.ts), at its price; without one, a model whose provider
// fetches on its own does (OpenRouter's auto), at a price that provider sets
// and OpenRouter passes on, which Cubex doesn't know (null).
export function fetchWork(limits: FetchLimits | null | undefined, nativeFetch: boolean) {
  return {
    fetchPages: capped(WEB_FETCH_PAGES_PER_ROW, limits?.maxPagesPerRow ?? null),
    fetchTokensPerPage: capped(WEB_FETCH_TOKENS_PER_PAGE, limits?.maxContentTokens ?? null),
    fetchPricePerPage: hasFetchLimits(limits) || !nativeFetch ? WEB_FETCH_USD_PER_PAGE : null,
  };
}

const add = (a: Range, b: Range): Range => ({ low: a.low + b.low, high: a.high + b.high });
const times = (count: Range, each: number | Range): Range => typeof each === 'number'
  ? { low: count.low * each, high: count.high * each }
  : { low: count.low * each.low, high: count.high * each.high };

// Searches a row runs when there's no history to go by: a cap bounds them; on
// OpenRouter's engines the result limit stops a row after about two; a model's
// own search has no such stop.
export function defaultSearchesPerRow(cap: number | null, native: boolean): Range {
  if (cap !== null) return { low: Math.min(1, cap), high: cap };
  return native ? WEB_SEARCHES_PER_ROW_NATIVE : WEB_SEARCHES_PER_ROW;
}

// Fees per row. The search or fetch part is left out when its price is unknown
// (the caller says so in the estimate's note).
export function webFeesPerRow(w: RowWebWork): Range {
  let fees = { low: 0, high: 0 };
  if (w.searches && w.pricePerSearch !== null) fees = add(fees, times(w.searches, w.pricePerSearch));
  const pagePrice = w.fetchPricePerPage === undefined ? WEB_FETCH_USD_PER_PAGE : w.fetchPricePerPage;
  if (w.fetch && pagePrice !== null) fees = add(fees, times(w.fetchPages ?? WEB_FETCH_PAGES_PER_ROW, pagePrice));
  return fees;
}

export function webInputTokensPerRow(w: RowWebWork): Range {
  let tokens = { low: 0, high: 0 };
  if (w.searches) tokens = add(tokens, times(w.searches, WEB_SEARCH_TOKENS_PER_SEARCH));
  if (w.fetch) {
    const pages = w.fetchPages ?? WEB_FETCH_PAGES_PER_ROW;
    tokens = add(tokens, times(pages, w.fetchTokensPerPage ?? WEB_FETCH_TOKENS_PER_PAGE));
  }
  return tokens;
}
