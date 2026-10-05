// What web search and web fetch add to one row of an AI run, for estimate_only:
// the provider fees, and the input tokens the found or fetched text adds to the
// prompt. Pure (constants-ai.ts holds the numbers and where they come from).
import {
  WEB_SEARCH_USD_PER_SEARCH, WEB_SEARCHES_PER_ROW, WEB_FETCH_USD_PER_PAGE, WEB_FETCH_PAGES_PER_ROW,
  WEB_SEARCH_TOKENS_PER_SEARCH, WEB_FETCH_TOKENS_PER_PAGE,
} from './constants-ai';

export interface Range { low: number; high: number }
export interface WebTools { search: boolean; fetch: boolean }

const add = (a: Range, b: Range): Range => ({ low: a.low + b.low, high: a.high + b.high });
const times = (count: Range, each: number | Range): Range => typeof each === 'number'
  ? { low: count.low * each, high: count.high * each }
  : { low: count.low * each.low, high: count.high * each.high };

export function webFeesPerRow(web: WebTools): Range {
  let fees = { low: 0, high: 0 };
  if (web.search) fees = add(fees, times(WEB_SEARCHES_PER_ROW, WEB_SEARCH_USD_PER_SEARCH));
  if (web.fetch) fees = add(fees, times(WEB_FETCH_PAGES_PER_ROW, WEB_FETCH_USD_PER_PAGE));
  return fees;
}

export function webInputTokensPerRow(web: WebTools): Range {
  let tokens = { low: 0, high: 0 };
  if (web.search) tokens = add(tokens, times(WEB_SEARCHES_PER_ROW, WEB_SEARCH_TOKENS_PER_SEARCH));
  if (web.fetch) tokens = add(tokens, times(WEB_FETCH_PAGES_PER_ROW, WEB_FETCH_TOKENS_PER_PAGE));
  return tokens;
}
