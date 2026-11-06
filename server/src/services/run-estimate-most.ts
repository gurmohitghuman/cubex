// The most one row of an AI run can cost as its spend limit counts it before
// the row starts (lib/ai-spend-limit.ts, the same figures services/
// ai-spend-gate.ts holds), for an estimate (run-estimate.ts): the sampled row
// with the longest prompt, with the run's system prompt, structured output
// instruction, web tools and max_tokens. A pure read.
import { processPromptTemplate } from '../lib/prompt';
import { rowFixedFor, rowMaxMicro, type RowPrices } from '../lib/ai-spend-limit';
import type { SearchPlan } from '../lib/web-search-plan';
import type { AiEstimateInput } from './run-estimate';

export function rowMostUsd(
  prices: RowPrices, model: string, input: AiEstimateInput, plan: SearchPlan | null,
  sample: Array<Record<string, string>>, columns: readonly string[],
): number {
  const fixed = rowFixedFor({
    model, systemPrompt: input.systemPrompt ?? null, outputColumns: input.outputColumns ?? null,
    maxChars: input.maxChars,
    web: {
      search: !!input.useOpenRouterWebSearch, fetch: !!input.useWebFetch, used: plan?.used ?? null,
      mode: plan?.mode ?? null, maxPerRow: plan?.maxPerRow ?? null,
    },
  });
  const rows = sample.length ? sample : [{}];
  const longest = Math.max(
    ...rows.map(d => Buffer.byteLength(processPromptTemplate(input.prompt, d, columns), 'utf8')));
  return rowMaxMicro(prices, fixed, longest) / 1e6;
}
