// A row with web search goes through OpenRouter's Responses API, because it is
// the only API that reports the searches themselves: each one is an output item
// {type:'openrouter:web_search', action:{type:'search', query, sources?}}. Chat
// Completions reports only a count, and that count includes searches a cap
// blocked (probed 2026-10-05: 3 reported, 1 billed). This file turns that
// answer into the chat-completion shape the rest of the pipeline reads
// (extractCompletionText, citationsFromCompletion), and lists the searches.
// Pure: unit-tested against recorded responses (tests/unit/web-search-controls.test.ts).
import { stripControlChars } from './csv-safety';

export interface ChatLikeCompletion {
  choices: Array<{
    message: { role: 'assistant'; content: string; refusal: string | null; annotations: unknown[] };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown };
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
    usage: { prompt_tokens: r?.usage?.input_tokens, completion_tokens: r?.usage?.output_tokens, cost: r?.usage?.cost },
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
      queries.push({ query: stripControlChars(text).trim().slice(0, MAX_QUERY_CHARS), ran: !refused });
    }
  }
  return { queries, searches: ran };
}

const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;

// Tokens and what OpenRouter charged (usage.cost: tokens plus web fees) from
// either API's answer. Anything missing or malformed is null, never a failure.
export function usageOf(completion: { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown } }):
  { promptTokens: number | null; completionTokens: number | null; costUsd: number | null } {
  const u = completion?.usage;
  const cost = u?.cost;
  return {
    promptTokens: count(u?.prompt_tokens),
    completionTokens: count(u?.completion_tokens),
    costUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
  };
}
