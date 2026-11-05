// An AI run's hard spend limit, worked out (pure; services/ai-spend-gate.ts
// reads the numbers and holds the room). Before a row starts, what the run
// spent, plus the most its rows still out can cost, plus the most this row can
// cost must stay within the limit: then it starts and its most is held until
// it settles. A row whose call may be billed with no cost Cubex saw (cut off
// before its answer came back) counts its most as spent from then on, for the
// rest of the run (ai_runs.spend_cut_off_micro, migration 052). When only rows
// out are in the way, it waits for them; when what was spent (and held for
// such calls) leaves no room for this row, the run pauses, so it never waits
// with nothing out.
//
// A row's most, at the model's listed prices: its messages counted as one
// token a byte (no tokenizer makes more tokens than bytes) plus each message's
// framing, the whole output the call may make (the max_tokens it sends), and
// the model's per-request fee. Text only, that is a true ceiling. With web
// search or fetch it also counts the search and fetch fees and the text they
// bring in, which Cubex can only estimate (the most searches a row may run:
// its max_searches_per_row, else the usual count), so there a row can cost
// more than its most. A model with no listed price (none, or a negative one)
// has no most: such a run stops once what was billed reaches the limit.
import {
  AI_HOLD_MESSAGE_TOKENS, AI_HOLD_WEB_TOOLS_TOKENS, AI_RESET_MAYBE_BILLED_MS, WEB_FETCH_PAGES_PER_ROW,
  WEB_FETCH_TOKENS_PER_PAGE, WEB_FETCH_USD_PER_PAGE, WEB_SEARCH_TOKENS_PER_SEARCH, WEB_SEARCHES_PER_ROW,
  WEB_SEARCHES_PER_ROW_NATIVE,
} from './constants';
import { aiMaxTokens } from './constants-ai';
import { enginePrice, nativeSearchProvider, type BilledEngine } from './web-search-pricing';
import { buildMultiOutputInstruction, type OutputColumnSpec } from './ai-multi-output';
import { WEB_SYSTEM_MESSAGE } from './ai-web-tools';
import { money } from './cost-ceiling';

// A model's listed prices in USD: per prompt token, per output token (the
// dearer of output and reasoning) and per request.
export interface RowPrices { prompt: number; completion: number; request: number }

// null: not a price (a negative one such as openrouter/auto's "-1", which
// means the price varies, or junk); a price left out is 0.
const price = (raw: string | undefined): number | null => {
  if (raw === undefined || raw === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
// The listed prices, or null when any of them isn't one: no listed price.
export function rowPricesOf(p: { prompt: string; completion: string; request?: string; internal_reasoning?: string })
  : RowPrices | null {
  const prompt = price(p.prompt), completion = price(p.completion), request = price(p.request);
  const reasoning = price(p.internal_reasoning);
  if (prompt === null || completion === null || request === null || reasoning === null) return null;
  return { prompt, completion: Math.max(completion, reasoning), request };
}

// The id the model list prices a model under: routing variants that keep the
// model and its prices (":nitro", ":floor", ":exacto") and a preset after it
// are left out. ":online" adds web search fees, so it stays (and is unpriced).
const SAME_PRICE_VARIANTS = /:(nitro|floor|exacto)$/;
export function priceModelId(model: string): string {
  let id = model.trim();
  const preset = id.indexOf('@preset/');
  if (preset > 0) id = id.slice(0, preset);
  while (SAME_PRICE_VARIANTS.test(id)) id = id.replace(SAME_PRICE_VARIANTS, '');
  return id;
}

// What every row of a run adds to its most, besides its own prompt text.
export interface RowFixed {
  maxTokens: number;     // the output the call may make
  fixedBytes: number;    // system prompt, a structured run's instruction, the web tools' system message
  messages: number;      // messages sent (their framing)
  webTokens: number;     // what the web tools bring into the prompt, at most as estimated
  webFeesUsd: number;    // search and fetch fees, at most as estimated
}

export interface WebSettings {
  model: string; search: boolean; fetch: boolean; used: string | null; mode: string | null; maxPerRow: number | null;
}

// Web search and fetch for one row: tokens they add and fees, at the high end.
export function webPart(w: WebSettings): { tokens: number; feesUsd: number } {
  let tokens = 0, fees = 0;
  if (w.search) {
    const native = w.used === 'native';
    const searches = w.maxPerRow ?? (native ? WEB_SEARCHES_PER_ROW_NATIVE.high : WEB_SEARCHES_PER_ROW.high);
    const each = native ? nativeSearchProvider(w.model).price
      : enginePrice((w.used ?? 'exa') as BilledEngine, w.mode, {});
    tokens += searches * WEB_SEARCH_TOKENS_PER_SEARCH.high;
    fees += searches * (each ?? 0);
  }
  if (w.fetch) {
    tokens += WEB_FETCH_PAGES_PER_ROW.high * WEB_FETCH_TOKENS_PER_PAGE.high;
    fees += WEB_FETCH_PAGES_PER_ROW.high * WEB_FETCH_USD_PER_PAGE;
  }
  if (w.search || w.fetch) tokens += AI_HOLD_WEB_TOOLS_TOKENS;
  return { tokens, feesUsd: fees };
}

// What a row sends besides its own prompt, as ai-row.ts and ai-row-multi.ts
// build it, from a run's settings (services/ai-spend-gate.ts) or an estimate's
// (services/run-estimate.ts).
export interface RowSettings {
  model: string; systemPrompt: string | null; outputColumns: OutputColumnSpec[] | null; maxChars: number | null;
  web: Omit<WebSettings, 'model'>;
}
const bytes = (s: string | null | undefined): number => (s ? Buffer.byteLength(s, 'utf8') : 0);
export function rowFixedFor(r: RowSettings): RowFixed {
  const withWeb = r.web.search || r.web.fetch;
  const web = webPart({ model: r.model, ...r.web });
  let fixedBytes: number, messages: number;
  if (r.outputColumns) {
    const instruction = buildMultiOutputInstruction(r.outputColumns, { withSources: withWeb });
    fixedBytes = bytes(r.systemPrompt) + bytes(`\n\n${instruction}`);
    messages = r.systemPrompt ? 2 : 1;
  } else {
    const system = withWeb ? WEB_SYSTEM_MESSAGE : r.systemPrompt;
    fixedBytes = bytes(system);
    messages = system ? 2 : 1;
  }
  // The output part is the max_tokens the row sends (ai-row.ts), nothing more.
  return { maxTokens: aiMaxTokens(r.maxChars), fixedBytes, messages, webTokens: web.tokens, webFeesUsd: web.feesUsd };
}

// The most one row can cost, in micro-dollars rounded up. promptBytes: the
// row's own prompt text (UTF-8 bytes).
export function rowMaxMicro(prices: RowPrices, f: RowFixed, promptBytes: number): number {
  const inputTokens = promptBytes + f.fixedBytes + f.messages * AI_HOLD_MESSAGE_TOKENS + f.webTokens;
  const usd = inputTokens * prices.prompt + f.maxTokens * prices.completion + prices.request + f.webFeesUsd;
  return Math.max(0, Math.ceil(usd * 1e6 - 1e-6));
}

// Start the row (its most is held), wait for rows out to settle, or pause.
// heldMicro: what rows still out hold, which comes back as they settle;
// stuckMicro: what calls cut off before they answered hold, which never comes
// back (each may be billed), so it counts with what was spent. A row counts as
// at least a micro-dollar, so a free row still stops at a limit reached (by a
// run with no listed price, on what was billed).
export type AdmitDecision = 'start' | 'wait' | 'pause';
export function admitRow(a: {
  limitMicro: number; spentMicro: number; heldMicro: number; stuckMicro: number; rowMicro: number;
}): AdmitDecision {
  const row = Math.max(a.rowMicro, 1);
  const gone = a.spentMicro + a.stuckMicro;
  if (gone + row > a.limitMicro) return 'pause';
  if (gone + a.heldMicro + row > a.limitMicro) return 'wait';
  return 'start';
}

// The pause, in enrichment runs' words (services/enrich-runner.ts). stuckUsd:
// held for calls cut off before they answered.
export function spendLimitMessage(limitUsd: number, spentUsd: number, rowUsd: number | null, stuckUsd = 0): string {
  const cut = stuckUsd > 0 ? ` Calls cut off before their answer came back may still be billed (up to `
    + `${money(stuckUsd)}), so that counts as spent.` : '';
  const next = rowUsd === null
    ? ' No price is listed for its model, so it stopped on what was billed.'
    : spentUsd + stuckUsd < limitUsd ? ` The next row could cost up to ${money(rowUsd)}, more than is left.` : '';
  return `The run reached its ${money(limitUsd)} spend limit (${money(spentUsd)} spent).${cut}${next} `
    + 'Resume it with a higher limit to go on.';
}

// A run with a limit whose model list couldn't be read: it pauses (pause_reason
// provider_errors) rather than run rows it can't price.
export const PRICE_UNREAD_MESSAGE = "Cubex couldn't read the model's price from OpenRouter's model list, and the "
  + "run's spend limit needs it, so the run paused before its next row. Resume it to try again.";

// What the agent-facing tools say about an AI run's spend limit (and when spend can pass it).
export const AI_SPEND_LIMIT_NOTE = 'The run starts a row only while what it spent, plus the most its rows still '
  + 'out and that row can cost (its prompt counted as one token a byte, plus all the output the call may write, '
  + "at least 8,000 tokens, at the model's listed prices), stays within the limit. Otherwise it waits for rows "
  + 'out, or pauses with pause_reason spend_limit and its rows not started stay ⏳; control_run resume with a '
  + 'higher spend_limit_usd goes on (at least what it spent, plus what its cut-off calls hold, plus its next '
  + "row's most: a lower one is refused, saying what to raise it to). Near the limit fewer rows run at once and up "
  + "to one row's most can stay unspent. A call cut off before it answered, or whose connection was reset "
  + `${AI_RESET_MAYBE_BILLED_MS / 1000} seconds or more after it went out, counts at its most for the rest of the `
  + 'run (it may still be billed). '
  + "Spend can pass the limit only: with web search or fetch (a row's most counts their fees and found text as "
  + 'estimated), on a model with no listed price (it stops once what was billed reaches it, so it passes by the '
  + 'rows out then), when the server restarts while calls are out, and when a call tried again after a late '
  + 'reset answers (only that answer\'s cost counts).'
  + " If OpenRouter's model list can't be read, the run pauses (pause_reason provider_errors); resume to retry.";
