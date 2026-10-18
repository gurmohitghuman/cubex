// What one AI step call costs, priced the way an AI column's estimate prices
// a row (services/run-estimate.ts): its messages' tokens on sample rows, the
// output size from your past runs on the model (or the default range), the
// model's prices, and with web search the engine the column would plan
// (services/run-estimate-web.ts) and its fees. The cap is one call's ceiling:
// the longest sample row's input, the step's output token limit, the most
// searches (a row longer than every sample row can cost more; the run counts
// what each call really cost the moment it comes back).
import { WATERFALL_AI_MAX_TOKENS } from '../lib/constants';
import { fetchModels } from '../lib/openrouter';
import { average, estimateTokens, parseTokenPrice, rowCostUsd } from '../lib/ai-cost';
import { webFeesPerRow, webInputTokensPerRow, type WebTools } from '../lib/ai-web-cost';
import type { SearchToolConfig } from '../lib/ai-web-tools';
import type { WaterfallBlock } from '../lib/waterfall/config';
import { estimateWebWork } from './run-estimate-web';
import { tokenHistory } from './ai-token-history';
import { aiMessages } from './waterfall-step-ai';

// Caps and holds need micro-dollar precision (roundUsd rounds for display).
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

export interface AiStepPrice {
  search: SearchToolConfig | null;
  capUsd: number; lowUsd: number; highUsd: number;
  priced: boolean;                    // false: OpenRouter's prices weren't available (costs read 0)
  note: string | null;
}

export async function priceAiStep(
  userId: string, w: Pick<WaterfallBlock, 'resultType' | 'phone'>, model: string, prompt: string, webSearch: boolean,
  sample: Array<Record<string, string>>,
): Promise<{ ok: AiStepPrice } | { error: string }> {
  const web: WebTools = { search: webSearch, fetch: false };
  const est = await estimateWebWork(userId, model, web, null);
  if ('error' in est) return est;
  const plan = est.ok.plan;
  const search: SearchToolConfig | null = webSearch && plan
    ? { engine: plan.engine, used: plan.used, mode: plan.mode, maxPerRow: plan.maxPerRow } : null;
  const block = { ...w } as WaterfallBlock;
  const tokensOf = (inputs: Record<string, string>) =>
    aiMessages(block, prompt, inputs).reduce((n, m) => n + estimateTokens(m.content), 0);
  const sizes = sample.map(tokensOf);
  const avgIn = Math.round(average(sizes) ?? tokensOf({}));
  const maxIn = Math.max(avgIn, ...sizes);
  const history = tokenHistory(userId, model, web, plan?.used ?? null);
  const out = history.output.range;
  const extra = webSearch && !history.webInput ? webInputTokensPerRow(est.ok.work) : { low: 0, high: 0 };
  const inLow = history.webInput ? Math.max(history.webInput.low, avgIn) : avgIn + extra.low;
  const inHigh = history.webInput ? Math.max(history.webInput.high, avgIn) : avgIn + extra.high;
  const inMost = history.webInput ? Math.max(history.webInput.high, maxIn) : maxIn + extra.high;
  const fees = webSearch ? webFeesPerRow(est.ok.work) : { low: 0, high: 0 };
  const result = await fetchModels(Date.now());
  const m = (result.ok ? result.models : result.stale)?.find(x => x.id === model);
  if (!m) {
    return {
      ok: {
        search, capUsd: 0, lowUsd: 0, highUsd: 0, priced: false,
        note: "OpenRouter's prices for this model weren't available, so this step's cost isn't counted.",
      },
    };
  }
  const p = parseTokenPrice(m.pricing.prompt);
  const c = parseTokenPrice(m.pricing.completion);
  const cap = rowCostUsd(inMost, WATERFALL_AI_MAX_TOKENS, p, c) + fees.high;
  const low = rowCostUsd(inLow, out.low, p, c) + fees.low;
  const high = rowCostUsd(inHigh, Math.min(out.high, WATERFALL_AI_MAX_TOKENS), p, c) + fees.high;
  return {
    ok: {
      search, priced: true, note: null, capUsd: round6(cap),
      lowUsd: round6(Math.min(cap, low)), highUsd: round6(Math.min(cap, high)),
    },
  };
}
