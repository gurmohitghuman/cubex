// estimate_only (dry-run cost) for run_ai_column / run_http_enrichment. PURE
// READ — no columns, placeholders, drafts, runs, or DB writes of any kind (risk
// A1: never call startAiRun/startHttpRun from here). Returns a priced RANGE for
// AI (Clay's variable-price shape: honest low/high, "actual depends on usage"),
// web search and fetch fees included. HTTP's estimate: run-estimate-http.ts.
import { db } from '../lib/db';
import { AI_ESTIMATE_DEFAULT_OUTPUT_TOKENS_LOW, AI_ESTIMATE_DEFAULT_OUTPUT_TOKENS_HIGH } from '../lib/constants-ai';
import { processPromptTemplate } from '../lib/prompt';
import { unknownPromptRefsError } from '../lib/prompt-ref-validate';
import { resolveAiModel } from '../lib/ai-model-resolve';
import { fetchModels } from '../lib/openrouter';
import { parseTokenPrice, estimateTokens, average, rowCostUsd, roundUsd } from '../lib/ai-cost';
import { buildMultiOutputInstruction, type OutputColumnSpec } from '../lib/ai-multi-output';
import { webFeesPerRow, webInputTokensPerRow, type Range, type WebTools } from '../lib/ai-web-cost';
import type { SearchOptions } from '../lib/web-search-options';
import { targetRowsAndSample } from './run-estimate-rows';
import { tokenHistory } from './ai-token-history';
import { estimateWebWork, webNote, webSearchEstimate } from './run-estimate-web';

export interface AiEstimateInput {
  sheetId: string;
  prompt: string;
  systemPrompt?: string;
  model?: string;
  useOpenRouterWebSearch?: boolean;
  useWebFetch?: boolean;
  outputColumns?: OutputColumnSpec[];
  maxChars: number | null;
  targetRowIndexes?: number[];
  search?: SearchOptions | null;
}

export interface AiEstimate {
  rows_to_process: number;
  model: string | null;
  pricing_available: boolean;
  // Tokens plus web fees.
  estimated_cost_usd: Range | null;
  per_row_usd: Range | null;
  // Web search and fetch fees alone, for the whole run; null without web tools.
  web_fees_usd: Range | null;
  // With web search: the engine it runs on, its price, searches a row
  // (run-estimate-web.ts). null without web search.
  web_search: ReturnType<typeof webSearchEstimate>;
  // 'measured': the search price is unknown, so the cost is what your past
  // runs with the same settings really cost per row.
  basis: 'history' | 'heuristic-no-history' | 'measured';
  assumptions: {
    avg_input_tokens: number;
    // Per row, with what the web tools read added in.
    input_tokens: Range;
    output_tokens: Range;
    sampled_rows: number;
    history_rows: number;
  };
  note: string;
}

export type AiEstimateOutcome =
  | { fail: 'not_found' | 'bad_request' | 'no_rows'; message: string }
  | { ok: AiEstimate };

export async function estimateAiRun(userId: string, input: AiEstimateInput): Promise<AiEstimateOutcome> {
  const owns = db.prepare('SELECT id FROM sheets WHERE id = ? AND user_id = ?').get(input.sheetId, userId);
  if (!owns) return { fail: 'not_found', message: 'Sheet not found' };

  // Same up-front ref rejection a real run does — never price a prompt that
  // would substitute "[MISSING]" on every row (A9).
  const refsError = unknownPromptRefsError(input.sheetId, userId, input.prompt);
  if (refsError) return { fail: 'bad_request', message: refsError };

  const { count, sample } = targetRowsAndSample(input.sheetId, userId, input.targetRowIndexes);
  if (count === 0) return { fail: 'no_rows', message: 'No rows to process.' };

  // Input tokens: render the prompt against sampled rows (+ system prompt, + a
  // structured run's JSON instruction) and average. Free — no API calls.
  const web: WebTools = { search: !!input.useOpenRouterWebSearch, fetch: !!input.useWebFetch };
  const usesWeb = web.search || web.fetch;
  const sysTokens = input.systemPrompt ? estimateTokens(input.systemPrompt) : 0;
  const instructionTokens = input.outputColumns
    ? estimateTokens(buildMultiOutputInstruction(input.outputColumns, { withSources: usesWeb })) : 0;
  const fixedTokens = sysTokens + instructionTokens;
  const perRowInput = sample.map(d => estimateTokens(processPromptTemplate(input.prompt, d)) + fixedTokens);
  const avgInputTokens = Math.round(average(perRowInput) ?? estimateTokens(input.prompt) + fixedTokens);

  const model = resolveAiModel(input.model, input.sheetId, userId);
  // The engine the searches would run on and its price: the plan a run would
  // store. Refused the same way a run would be (a cap that can't hold).
  const webEst = await estimateWebWork(userId, model, web, input.search);
  if ('error' in webEst) return { fail: 'bad_request', message: webEst.error };
  const w = webEst.ok;
  const history = model ? tokenHistory(userId, model, web, w.plan?.used ?? null) : null;
  const out = history?.output
    ?? { range: { low: AI_ESTIMATE_DEFAULT_OUTPUT_TOKENS_LOW, high: AI_ESTIMATE_DEFAULT_OUTPUT_TOKENS_HIGH }, historyRows: 0, basis: 'heuristic-no-history' as const };
  // What the web tools read lands in the prompt: past rows with the same tools
  // measured it (never less than this prompt alone, which can outgrow theirs);
  // otherwise the heuristic on top of this prompt.
  const extra = usesWeb && !history?.webInput ? webInputTokensPerRow(w.work) : { low: 0, high: 0 };
  const inputTokens: Range = history?.webInput
    ? { low: Math.max(history.webInput.low, avgInputTokens), high: Math.max(history.webInput.high, avgInputTokens) }
    : { low: avgInputTokens + extra.low, high: avgInputTokens + extra.high };
  const fees = usesWeb ? webFeesPerRow(w.work) : null;

  // Pricing: stale cache is fine for a cost hint. Missing model / fetch failure
  // -> pricing_available:false, cost null (never a hard error — the estimate is
  // advisory).
  let pricingAvailable = false;
  let row: Range | null = null;
  if (model) {
    const result = await fetchModels(Date.now());
    const models = result.ok ? result.models : result.stale;
    const m = models?.find(x => x.id === model);
    if (m) {
      pricingAvailable = true;
      const p = parseTokenPrice(m.pricing.prompt);
      const c = parseTokenPrice(m.pricing.completion);
      row = {
        low: rowCostUsd(inputTokens.low, out.range.low, p, c) + (fees?.low ?? 0),
        high: rowCostUsd(inputTokens.high, out.range.high, p, c) + (fees?.high ?? 0),
      };
    }
  }
  // A search price Cubex doesn't know (some providers' own search) would leave
  // the search fees out: what your runs with these settings cost is closer.
  let basis: AiEstimate['basis'] = out.basis;
  if (w.plan && w.plan.pricePerSearch === null && w.measuredCostPerRow) {
    row = w.measuredCostPerRow;
    pricingAvailable = true;
    basis = 'measured';
  }
  const perRow = row ? { low: roundUsd(row.low), high: roundUsd(row.high) } : null;
  const cost = row ? { low: roundUsd(row.low * count), high: roundUsd(row.high * count) } : null;

  const notes: string[] = ['Estimate only — actual cost depends on real token usage.'];
  if (out.basis === 'heuristic-no-history') {
    notes.push('No token history for this model yet; output size is a rough default. Run preview_rows for a measured per-row cost.');
  } else {
    notes.push('Output size estimated from your past runs on this model. Run preview_rows for exact measured cost.');
  }
  if (!model) notes.push('No model resolved — set a model to price this run.');
  else if (!pricingAvailable) notes.push('OpenRouter pricing was unavailable; row count is exact, cost is not shown.');
  if (fees) notes.push(webNote(w, fees, !!history?.webInput));

  return {
    ok: {
      rows_to_process: count,
      model,
      pricing_available: pricingAvailable,
      estimated_cost_usd: cost,
      per_row_usd: perRow,
      web_fees_usd: fees ? { low: roundUsd(fees.low * count), high: roundUsd(fees.high * count) } : null,
      web_search: webSearchEstimate(w),
      basis,
      assumptions: {
        avg_input_tokens: avgInputTokens,
        input_tokens: inputTokens,
        output_tokens: out.range,
        sampled_rows: sample.length,
        history_rows: out.historyRows,
      },
      note: notes.join(' '),
    },
  };
}
