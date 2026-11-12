// A row with web search goes through OpenRouter's Responses API, because it is
// the only API that reports the searches themselves: each one is an output item
// {type:'openrouter:web_search', action:{type:'search', query, sources?}}. Chat
// Completions reports only a count, and that count includes searches a cap
// blocked (probed 2026-10-05: 3 reported, 1 billed). This file turns that
// answer into the chat-completion shape the rest of the pipeline reads
// (extractCompletionText, citationsFromCompletion), and lists the searches.
// Pure: unit-tested against recorded responses (tests/unit/web-search-controls.test.ts).
import { stripControlAndC1Chars } from './csv-safety';

export interface ChatLikeCompletion {
  choices: Array<{
    message: { role: 'assistant'; content: string; refusal: string | null; annotations: unknown[] };
    finish_reason: string;
  }>;
  usage?: ChatLikeUsage;
}

// The usage fields Cubex reads, as Chat Completions names them.
export interface ChatLikeUsage {
  prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown; is_byok?: unknown; cost_details?: unknown;
  completion_tokens_details?: unknown;
}

// The search calls of one row, in order. ran: false for a call OpenRouter
// refused because the row had reached its cap or its result limit (nothing was
// searched or billed).
export interface SearchQueryLog { query: string; ran: boolean }
export interface SearchLog { queries: SearchQueryLog[]; searches: number }

// How to tell a refused call from one that ran. A call that ran but found
// nothing looks the same as a refused one (no sources), so the limits are
// replayed in order instead: OpenRouter refuses a call once the row has run
// `cap` searches or collected `maxTotalResults` results. Both are null for a
// model's own search, which OpenRouter doesn't police.
export interface SearchReplay { cap: number | null; maxTotalResults: number | null }

type Item = {
  type?: string;
  content?: Array<{ type?: string; text?: string; refusal?: string; annotations?: unknown[] }>;
  action?: { type?: string; query?: unknown; queries?: unknown; sources?: unknown };
};

const SEARCH_ITEMS = new Set(['openrouter:web_search', 'web_search_call']);
const MAX_LOGGED_QUERIES = 50;
const MAX_QUERY_CHARS = 500;

const items = (resp: unknown): Item[] => {
  const out = (resp as { output?: unknown } | null)?.output;
  return Array.isArray(out) ? out.filter((i): i is Item => !!i && typeof i === 'object') : [];
};

// The error of a response that failed (status 'failed'); null otherwise. Checked
// after the usage and searches are read, so a failed row still records what
// it cost (services/ai-model-call.ts).
export function responseError(resp: unknown): string | null {
  const r = resp as { status?: string; error?: { message?: string } } | null;
  return r?.status === 'failed' ? (r.error?.message || 'The model call failed.') : null;
}

export function completionFromResponse(resp: unknown): ChatLikeCompletion {
  const r = resp as { status?: string; incomplete_details?: { reason?: string }; usage?: any };
  const all = items(resp);
  // The answer is what the model wrote after its last tool call. Text written
  // before a search ("let me look that up") isn't part of it, so a response
  // that ends on a tool call (cut off, or out of tool calls) has no answer and
  // fails the row rather than saving that text.
  let lastTool = -1;
  all.forEach((it, i) => { if (it.type && it.type !== 'message' && it.type !== 'reasoning') lastTool = i; });
  const messages = all.slice(lastTool + 1).filter(it => it.type === 'message');
  const parts = messages.flatMap(m => (Array.isArray(m.content) ? m.content : []));
  const content = parts.filter(p => p?.type === 'output_text' && typeof p.text === 'string').map(p => p.text).join('\n');
  const refusal = parts.filter(p => p?.type === 'refusal').map(p => p.refusal ?? p.text ?? '').join(' ').trim();
  const annotations = parts
    .flatMap(p => (p?.type === 'output_text' && Array.isArray(p.annotations) ? p.annotations : []))
    .filter((a: any) => a?.type === 'url_citation' && typeof a.url === 'string')
    .map((a: any) => ({ type: 'url_citation', url_citation: { url: a.url, title: a.title, content: a.content } }));
  const reason = r?.incomplete_details?.reason;
  const finish = r?.status !== 'incomplete' ? 'stop'
    : reason === 'max_output_tokens' ? 'length' : reason === 'content_filter' ? 'content_filter' : (reason || 'incomplete');
  return {
    choices: [{ message: { role: 'assistant', content, refusal: refusal || null, annotations }, finish_reason: finish }],
    usage: {
      prompt_tokens: r?.usage?.input_tokens, completion_tokens: r?.usage?.output_tokens, cost: r?.usage?.cost,
      is_byok: r?.usage?.is_byok, cost_details: r?.usage?.cost_details,
      completion_tokens_details: r?.usage?.output_tokens_details,
    },
  };
}

export function searchLogFromResponse(resp: unknown, replay: SearchReplay): SearchLog {
  const queries: SearchQueryLog[] = [];
  let ran = 0;
  let results = 0;
  for (const it of items(resp)) {
    if (!SEARCH_ITEMS.has(it.type ?? '')) continue;
    const a = it.action ?? {};
    // OpenAI's own search also opens and scans pages; only searches count.
    if (a.type && a.type !== 'search') continue;
    const text = typeof a.query === 'string' ? a.query
      : Array.isArray(a.queries) ? a.queries.filter((q): q is string => typeof q === 'string').join(' | ') : '';
    const refused = (replay.cap !== null && ran >= replay.cap)
      || (replay.maxTotalResults !== null && results >= replay.maxTotalResults);
    if (!refused) {
      ran++;
      results += Array.isArray(a.sources) ? a.sources.length : 0;
    }
    if (queries.length < MAX_LOGGED_QUERIES) {
      queries.push({ query: stripControlAndC1Chars(text).trim().slice(0, MAX_QUERY_CHARS), ran: !refused });
    }
  }
  return { queries, searches: ran };
}

const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;

const usd = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

export type PaidWith = 'own_key' | 'credits';

export interface CallUsage {
  promptTokens: number | null; completionTokens: number | null;
  // Of the output tokens, those the model spent reasoning (null: not reported).
  reasoningTokens: number | null;
  costUsd: number | null;
  // On the user's own provider key (usage.is_byok): what that provider charged
  // (cost_details.upstream_inference_cost). null on every other call.
  providerCostUsd: number | null;
  // Who paid, as OpenRouter says (usage.is_byok): the user's own provider key,
  // or OpenRouter's credits (a call whose own key failed and fell back to
  // shared capacity among them). null when the answer doesn't say.
  paidWith: PaidWith | null;
}

// What the provider charged an own-key call. OpenRouter's schema makes the
// total nullable but always sends its two parts (input and output, named per
// API), so a call whose total is null is priced from them.
function upstreamCost(details: unknown): number | null {
  const d = details as Record<string, unknown> | null | undefined;
  const total = usd(d?.upstream_inference_cost);
  if (total !== null) return total;
  for (const [a, b] of [
    ['upstream_inference_prompt_cost', 'upstream_inference_completions_cost'],
    ['upstream_inference_input_cost', 'upstream_inference_output_cost'],
  ]) {
    const [x, y] = [usd(d?.[a]), usd(d?.[b])];
    // Rounded past float noise (0.0001 + 0.0002), far below a micro-dollar.
    if (x !== null && y !== null) return Math.round((x + y) * 1e12) / 1e12;
  }
  return null;
}

// Tokens and what OpenRouter charged (usage.cost: tokens plus web fees) from
// either API's answer. Anything missing or malformed is null, never a failure.
export function usageOf(completion: { usage?: ChatLikeUsage }): CallUsage {
  const u = completion?.usage;
  const details = u?.completion_tokens_details as { reasoning_tokens?: unknown } | null | undefined;
  return {
    promptTokens: count(u?.prompt_tokens),
    completionTokens: count(u?.completion_tokens),
    reasoningTokens: count(details?.reasoning_tokens),
    costUsd: usd(u?.cost),
    providerCostUsd: u?.is_byok === true ? upstreamCost(u?.cost_details) : null,
    paidWith: u?.is_byok === true ? 'own_key' : u?.is_byok === false ? 'credits' : null,
  };
}

// A row's tokens as the answers show them (preview_rows, get_run_results): null where not reported.
export interface RowTokens { input: number | null; output: number | null; reasoning: number | null }
export const tokensOf = (u: {
  promptTokens?: number | null; completionTokens?: number | null; reasoningTokens?: number | null;
}): RowTokens => ({
  input: u.promptTokens ?? null, output: u.completionTokens ?? null, reasoning: u.reasoningTokens ?? null,
});
