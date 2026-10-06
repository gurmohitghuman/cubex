// What one web search costs, by the engine that runs it.
//   - OpenRouter's own engines (Exa, Parallel, Perplexity) bill your OpenRouter
//     credits at the prices in its server-tool catalog, read live by
//     services/web-search-catalog.ts. FALLBACK_PRICES is that catalog as of
//     2026-10-05, for when it can't be read.
//   - A model's own ("native") search is billed by the model's provider at the
//     provider's price, which the catalog doesn't list. NATIVE holds the
//     providers' list prices (2026-10); unknown providers price as null.
// Each engine includes up to 10 results per search; Cubex asks for 5, so the
// per-result surcharge never applies.
import { DEFAULT_SEARCH_MODE, hasModes, type SearchEngineUsed } from './web-search-options';

export type BilledEngine = Exclude<SearchEngineUsed, 'native'>;
// engine -> mode -> USD per search ('' keys an engine without modes).
export type EnginePrices = Partial<Record<BilledEngine, Record<string, number>>>;

export const FALLBACK_PRICES: Record<BilledEngine, Record<string, number>> = {
  exa: { instant: 0.007, fast: 0.007, auto: 0.007, 'deep-lite': 0.012, deep: 0.012, 'deep-reasoning': 0.015 },
  parallel: { turbo: 0.001, fast: 0.001, basic: 0.005, advanced: 0.005 },
  perplexity: { '': 0.005 },
};

// By the author part of the model id.
const NATIVE: Record<string, { name: string; price: number | null }> = {
  openai: { name: 'OpenAI', price: 0.01 },          // $10 per 1,000 calls (GPT-5 family and later, o-series)
  anthropic: { name: 'Anthropic', price: 0.01 },    // $10 per 1,000 searches
  google: { name: 'Google', price: 0.014 },         // Gemini 3: $14 per 1,000 search queries
  'x-ai': { name: 'xAI', price: 0.005 },            // $5 per 1,000 calls
  perplexity: { name: 'Perplexity', price: null },  // part of the model's own request fee
};
// OpenAI charges its non-reasoning GPT-4.1 models $25 per 1,000 calls.
const OPENAI_NON_REASONING = /^openai\/gpt-4\.1/;

export function nativeSearchProvider(model: string): { name: string; price: number | null } {
  const author = model.split('/')[0].toLowerCase();
  const known = NATIVE[author];
  if (!known) {
    return { name: author ? author.charAt(0).toUpperCase() + author.slice(1) : 'The provider', price: null };
  }
  return author === 'openai' && OPENAI_NON_REASONING.test(model) ? { name: known.name, price: 0.025 } : known;
}

// USD per search on one of OpenRouter's engines at a mode (null: its default).
export function enginePrice(engine: BilledEngine, mode: string | null, prices: EnginePrices): number | null {
  const key = hasModes(engine) ? (mode ?? DEFAULT_SEARCH_MODE[engine]) : '';
  const p = prices[engine]?.[key] ?? FALLBACK_PRICES[engine][key];
  return typeof p === 'number' && Number.isFinite(p) && p >= 0 ? p : null;
}

// "$0.001", "$0.0125": a per-search or per-row price, without float noise.
export function formatSearchUsd(usd: number): string {
  return `$${Number(usd.toPrecision(3))}`;
}
