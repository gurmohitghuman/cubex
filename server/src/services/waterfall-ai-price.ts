// What one AI step call costs, priced the way an AI column's estimate prices
// a row (services/run-estimate.ts): its messages' tokens on sample rows, the
// output size from your past runs on the model (or the default range), the
// model's prices, and with web search the engine the column would plan
// (services/run-estimate-web.ts) and its fees; with page reading, the pages a
// row may read, their text and fees, as an AI column prices them. The cap is
// one call's ceiling, counted as an AI column's spend limit counts one
// (lib/ai-spend-limit.ts): the longest sample row's messages at one token a
// byte, the max_tokens the step sends at the dearer of the output and reasoning
// prices, the model's fee per request, the most searches and pages (a row
// longer than every sample row can cost more; the run counts what each call
// really cost the moment it comes back).
import { aiMaxTokens, AI_HOLD_MESSAGE_TOKENS } from '../lib/constants';
import { fetchModels } from '../lib/openrouter';
import { average, estimateTokens, rowCostUsd } from '../lib/ai-cost';
import { rowPricesOf } from '../lib/ai-spend-limit';
import { webFeesPerRow, webInputTokensPerRow, type WebTools } from '../lib/ai-web-cost';
import type { SearchToolConfig } from '../lib/ai-web-tools';
import type { WaterfallBlock } from '../lib/waterfall/config';
import { estimateWebWork } from './run-estimate-web';
import { tokenHistory } from './ai-token-history';
import { aiMessages, AI_STEP_FETCH_LIMITS } from './waterfall-step-ai';

// Caps and holds need micro-dollar precision (roundUsd rounds for display).
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

export interface AiStepPrice {
  search: SearchToolConfig | null;
  capUsd: number; lowUsd: number; highUsd: number;
  maxTokens: number;                  // what each call sends, as capUsd prices it (kept on BuiltAi)
  priced: boolean;                    // false: OpenRouter's prices weren't available (costs read 0)
  note: string | null;
}

export async function priceAiStep(
  userId: string, w: Pick<WaterfallBlock, 'resultType' | 'phone'>, model: string, prompt: string, web: WebTools,
  sample: Array<Record<string, string>>,
): Promise<{ ok: AiStepPrice } | { error: string }> {
  const webSearch = web.search;
  const usesWeb = web.search || web.fetch;
  // Page reading at the limits the step sends (AI_STEP_FETCH_LIMITS), so its pages and their text are a ceiling.
  const est = await estimateWebWork(userId, model, web, null, web.fetch ? AI_STEP_FETCH_LIMITS : null);
  if ('error' in est) return est;
  const plan = est.ok.plan;
  const search: SearchToolConfig | null = webSearch && plan
    ? { engine: plan.engine, used: plan.used, mode: plan.mode, maxPerRow: plan.maxPerRow } : null;
  const block = { ...w } as WaterfallBlock;
  const tokensOf = (inputs: Record<string, string>) =>
    aiMessages(block, prompt, inputs).reduce((n, m) => n + estimateTokens(m.content), 0);
  const sizes = sample.map(tokensOf);
  const avgIn = Math.round(average(sizes) ?? tokensOf({}));
  // The ceiling counts bytes, as an AI column's hold does: no model makes more tokens than bytes.
  const bytesOf = (inputs: Record<string, string>) => aiMessages(block, prompt, inputs)
    .reduce((n, m) => n + Buffer.byteLength(m.content, 'utf8') + AI_HOLD_MESSAGE_TOKENS, 0);
  const maxBytes = Math.max(bytesOf({}), ...sample.map(bytesOf));
  const history = tokenHistory(userId, model, web, plan?.used ?? null);
  const out = history.output.range;
  const extra = usesWeb && !history.webInput ? webInputTokensPerRow(est.ok.work) : { low: 0, high: 0 };
  const inLow = history.webInput ? Math.max(history.webInput.low, avgIn) : avgIn + extra.low;
  const inHigh = history.webInput ? Math.max(history.webInput.high, avgIn) : avgIn + extra.high;
  const webMost = usesWeb ? webInputTokensPerRow(est.ok.work).high : 0;
  const inMost = Math.max(history.webInput?.high ?? 0, maxBytes + webMost);
  const fees = usesWeb ? webFeesPerRow(est.ok.work) : { low: 0, high: 0 };
  const result = await fetchModels(Date.now());
  const m = (result.ok ? result.models : result.stale)?.find(x => x.id === model);
  // The step sends an AI column's max_tokens (lib/constants-ai.ts aiMaxTokens): room for a model that thinks
  // first to answer too (1,000 left such models without an answer).
  const maxOut = aiMaxTokens(null);
  // A negative listed price (openrouter/auto's "-1": it varies) is no price, never $0.
  const prices = m ? rowPricesOf(m.pricing) : null;
  if (!m || !prices) {
    return {
      ok: {
        search, capUsd: 0, lowUsd: 0, highUsd: 0, maxTokens: maxOut, priced: false,
        note: m ? "OpenRouter lists no fixed price for this model (it varies), so this step's cost isn't counted."
          : "OpenRouter's prices for this model weren't available, so this step's cost isn't counted.",
      },
    };
  }
  // The dearer of output and reasoning (rowPricesOf): a model that thinks bills its thinking too.
  const { prompt: p, completion: c, request } = prices;
  const cap = rowCostUsd(inMost, maxOut, p, c) + request + fees.high;
  const low = rowCostUsd(inLow, out.low, p, c) + request + fees.low;
  const high = rowCostUsd(inHigh, Math.min(out.high, maxOut), p, c) + request + fees.high;
  return {
    ok: {
      search, priced: true, note: null, capUsd: round6(cap), maxTokens: maxOut,
      lowUsd: round6(Math.min(cap, low)), highUsd: round6(Math.min(cap, high)),
    },
  };
}
