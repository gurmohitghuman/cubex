// Web fetch constants, split out of constants-ai.ts (which re-exports them):
// what a page costs, the limits a run can send, and what an estimate assumes
// a row reads.

// Fetch is $0.001 a page on Exa/Parallel (free on OpenRouter's own engine;
// a model's own fetch is billed at its provider's price, which OpenRouter
// passes through: https://openrouter.ai/docs/guides/features/server-tools/web-fetch).
export const WEB_FETCH_USD_PER_PAGE = 0.001;
// A model's own fetch has no price Cubex knows: estimates and the cost
// ceiling count it from $0 up to Exa's price a page.
export const WEB_FETCH_NATIVE_USD_PER_PAGE = { low: 0, high: WEB_FETCH_USD_PER_PAGE };
// The web fetch limits a run can send (max_content_tokens per page, max_uses
// as pages per row). Both ranges are Cubex's own: limits send the pages
// through Exa, which has no hard limit on fetches, and OpenRouter's docs give
// no range for the token limit.
export const WEB_FETCH_MAX_CONTENT_TOKENS_MIN = 100;
export const WEB_FETCH_MAX_CONTENT_TOKENS_MAX = 100_000;
export const WEB_FETCH_MAX_PAGES_PER_ROW = 50;
// The engine a run with a fetch limit fetches through: a model's own fetch
// doesn't cut pages to a token limit, Exa does (and takes max_uses).
export const WEB_FETCH_LIMITED_ENGINE = 'exa';
// Pages a row reads, as an estimate assumes them; the spend limit's worst case
// for a row takes the high end, or the run's limits where they allow more
// (lib/ai-spend-limit.ts).
export const WEB_FETCH_PAGES_PER_ROW = { low: 1, high: 3 };
// Input tokens a fetched page adds to a row's prompt, when there's no history
// of runs with the same web tools to go by.
export const WEB_FETCH_TOKENS_PER_PAGE = { low: 1_000, high: 6_000 };
