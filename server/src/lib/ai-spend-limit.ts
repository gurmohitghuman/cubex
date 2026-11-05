// An AI run's hard spend limit, worked out (pure; services/ai-spend-gate.ts
// reads the numbers and holds the room). Before a row starts, what the run
// spent, plus the most its rows still out can cost, plus the most this row can
// cost must stay within the limit: then it starts and its most is held until
// it settles. When only rows out are in the way, it waits for them; when what
// was spent alone leaves no room for this row, the run pauses.
//
// A row's most, at the model's listed prices: its messages counted as one
// token a byte (no tokenizer makes more tokens than bytes) plus each message's
// framing, the whole output the call may make (max_tokens), and the model's
// per-request fee. Text only, that is a true ceiling, so the run never spends
// past its limit. With web search or fetch it also counts the search and fetch
// fees and the text they bring in, which Cubex can only estimate (the most
// searches a row may run: its max_searches_per_row, else the usual count), so
// there a row can cost more than its most. A model with no listed price has no
// most: such a run stops once what was billed reaches the limit.
import {
  AI_HOLD_MESSAGE_TOKENS, AI_HOLD_WEB_TOOLS_TOKENS, WEB_FETCH_PAGES_PER_ROW, WEB_FETCH_TOKENS_PER_PAGE,
  WEB_FETCH_USD_PER_PAGE, WEB_SEARCH_TOKENS_PER_SEARCH, WEB_SEARCHES_PER_ROW, WEB_SEARCHES_PER_ROW_NATIVE,
} from './constants';
import { enginePrice, nativeSearchProvider, type BilledEngine } from './web-search-pricing';
import { money } from './cost-ceiling';

// A model's listed prices in USD: per prompt token, per output token (the
// dearer of output and reasoning) and per request.
export interface RowPrices { prompt: number; completion: number; request: number }

const price = (raw: string | undefined): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
export function rowPricesOf(p: { prompt: string; completion: string; request?: string; internal_reasoning?: string })
  : RowPrices {
  return {
    prompt: price(p.prompt), completion: Math.max(price(p.completion), price(p.internal_reasoning)),
    request: price(p.request),
  };
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

// The most one row can cost, in micro-dollars rounded up. promptBytes: the
// row's own prompt text (UTF-8 bytes).
export function rowMaxMicro(prices: RowPrices, f: RowFixed, promptBytes: number): number {
  const inputTokens = promptBytes + f.fixedBytes + f.messages * AI_HOLD_MESSAGE_TOKENS + f.webTokens;
  const usd = inputTokens * prices.prompt + f.maxTokens * prices.completion + prices.request + f.webFeesUsd;
  return Math.max(0, Math.ceil(usd * 1e6 - 1e-6));
}

// Start the row (its most is held), wait for rows out to settle, or pause.
// A row counts as at least a micro-dollar, so a free row still stops at a
// limit reached (by a run with no listed price, on what was billed).
export type AdmitDecision = 'start' | 'wait' | 'pause';
export function admitRow(a: { limitMicro: number; spentMicro: number; heldMicro: number; rowMicro: number })
  : AdmitDecision {
  const row = Math.max(a.rowMicro, 1);
  if (a.spentMicro + row > a.limitMicro) return 'pause';
  if (a.spentMicro + a.heldMicro + row > a.limitMicro) return 'wait';
  return 'start';
}

// The pause, in enrichment runs' words (services/enrich-runner.ts).
export function spendLimitMessage(limitUsd: number, spentUsd: number, rowUsd: number | null): string {
  const next = rowUsd === null
    ? ' No price is listed for its model, so it stopped on what was billed.'
    : spentUsd < limitUsd ? ` The next row could cost up to ${money(rowUsd)}, more than is left.` : '';
  return `The run reached its ${money(limitUsd)} spend limit (${money(spentUsd)} spent).${next} `
    + 'Resume it with a higher limit to go on.';
}

// What the agent-facing tools say about an AI run's spend limit (and how far past it spend can go).
export const AI_SPEND_LIMIT_NOTE = 'The run starts a row only while what it spent, plus the most its rows still '
  + 'out and that row can cost (its prompt counted as one token a byte, plus all the output the call may write, '
  + "at the model's listed prices), stays within the limit. Otherwise it waits for rows out, or pauses with "
  + 'pause_reason spend_limit and its rows not started stay ⏳; control_run resume with a higher spend_limit_usd '
  + 'goes on. Without web tools it never spends past the limit, and near it fewer rows run at once and a little '
  + "can stay unspent. With web search or fetch a row's most counts the fees and the text they bring in as "
  + 'estimated, so such a run can pass the limit by what its last rows cost over that. A model with no listed '
  + 'price stops only once what was billed reaches the limit, so it can pass it by the rows out at that moment.';
