// The max_tokens an AI row sends. A model that thinks before it answers spends output tokens thinking, so a row
// gets at least AI_MIN_OUTPUT_TOKENS (lib/constants-ai.ts aiMaxTokens: at 1,000 such models came back with no
// answer). A one-column row with max_chars on a model that doesn't (OpenRouter's model list shows no sign of it:
// lib/openrouter.ts modelThinksFirst) needs room for that answer only, so it sends less, and what that call holds
// shrinks with it: the run's spend limit (lib/ai-spend-limit.ts rowFixedFor) and OpenRouter's in-flight budget,
// which holds each request's input plus its max_tokens against the account. That is max_chars at
// AI_PLAIN_TOKENS_PER_CHAR tokens a character (Japanese, Chinese or Thai take about one each, some tokenizers more)
// plus AI_PLAIN_TOKEN_SLACK, never more than aiMaxTokens would send; the answer is cut to max_chars after. Without
// max_chars a row keeps the floor (a long answer must not be cut), and so does a model that thinks or that the list
// doesn't show, and a structured row (one answer fills several columns).
import { aiMaxTokens, AI_PLAIN_TOKEN_SLACK, AI_PLAIN_TOKENS_PER_CHAR } from './constants-ai';
import { modelThinksFirst } from './openrouter';

// thinks: modelThinksFirst's answer (null: not known, read as thinking).
export function proseMaxTokens(maxChars: number | null | undefined, thinks: boolean | null): number {
  const most = aiMaxTokens(maxChars);
  if (thinks !== false || !maxChars || maxChars <= 0) return most;
  return Math.min(most, maxChars * AI_PLAIN_TOKENS_PER_CHAR + AI_PLAIN_TOKEN_SLACK);
}

// A row's max_tokens from its run's settings, reading the cached model list (never a fetch: callers warm it).
export function rowMaxTokens(r: { model: string | null; maxChars: number | null | undefined; structured: boolean })
  : number {
  if (r.structured || !r.model || !r.maxChars) return aiMaxTokens(r.maxChars);
  return proseMaxTokens(r.maxChars, modelThinksFirst(r.model));
}
