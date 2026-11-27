// The max_tokens an AI row sends. A model that thinks before it answers spends output tokens thinking, so a row
// gets at least AI_MIN_OUTPUT_TOKENS (lib/constants-ai.ts aiMaxTokens: at 1,000 such models came back with no
// answer). A model that doesn't (OpenRouter's model list shows no reasoning: lib/openrouter.ts modelThinksFirst)
// needs room for the answer only, so a one-column row sends less, and what that call holds shrinks with it: the
// run's spend limit (lib/ai-spend-limit.ts rowFixedFor) and OpenRouter's in-flight budget, which holds each
// request's input plus its max_tokens against the account. That is max_chars at AI_PLAIN_CHARS_PER_TOKEN
// characters a token (fewer than English's ~4, so other scripts fit) plus AI_PLAIN_TOKEN_SLACK, or
// AI_PLAIN_OUTPUT_TOKENS (about 16,000 characters) without max_chars. A model that thinks, or one the list
// doesn't show, keeps the floor; a structured row always does (one answer fills several columns).
import {
  aiMaxTokens, AI_MAX_OUTPUT_TOKENS, AI_PLAIN_CHARS_PER_TOKEN, AI_PLAIN_OUTPUT_TOKENS, AI_PLAIN_TOKEN_SLACK,
} from './constants-ai';
import { modelThinksFirst } from './openrouter';

// thinks: modelThinksFirst's answer (null: not known, read as thinking).
export function proseMaxTokens(maxChars: number | null | undefined, thinks: boolean | null): number {
  if (thinks !== false) return aiMaxTokens(maxChars);
  if (!maxChars || maxChars <= 0) return AI_PLAIN_OUTPUT_TOKENS;
  return Math.min(AI_MAX_OUTPUT_TOKENS, Math.ceil(maxChars / AI_PLAIN_CHARS_PER_TOKEN) + AI_PLAIN_TOKEN_SLACK);
}

// A row's max_tokens from its run's settings, reading the cached model list (never a fetch: callers warm it).
export function rowMaxTokens(r: { model: string | null; maxChars: number | null | undefined; structured: boolean })
  : number {
  if (r.structured || !r.model) return aiMaxTokens(r.maxChars);
  return proseMaxTokens(r.maxChars, modelThinksFirst(r.model));
}
