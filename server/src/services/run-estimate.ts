// estimate_only (dry-run cost) for run_ai_column / run_http_enrichment. PURE
// READ — no columns, placeholders, drafts, runs, or DB writes of any kind (risk
// A1: never call startAiRun/startHttpRun from here). Returns a priced RANGE for
// AI (Clay's variable-price shape: honest low/high, "actual depends on usage"),
// and a row count + no-AI-cost note for HTTP.
import { db } from '../lib/db';
import {
  AI_ESTIMATE_SAMPLE_ROWS, AI_ESTIMATE_MIN_HISTORY,
  AI_ESTIMATE_DEFAULT_OUTPUT_TOKENS_LOW, AI_ESTIMATE_DEFAULT_OUTPUT_TOKENS_HIGH,
} from '../lib/constants-ai';
import { processPromptTemplate } from '../lib/prompt';
import { unknownPromptRefsError } from '../lib/prompt-ref-validate';
import { resolveAiModel } from '../lib/ai-model-resolve';
import { fetchModels } from '../lib/openrouter';
import {
  parseTokenPrice, estimateTokens, percentile, average, rowCostUsd, roundUsd,
} from '../lib/ai-cost';

export interface AiEstimateInput {
  sheetId: string;
  prompt: string;
  systemPrompt?: string;
  model?: string;
  useOpenRouterWebSearch?: boolean;
  maxChars: number | null;
  targetRowIndexes?: number[];
}

interface Range { low: number; high: number }
export interface AiEstimate {
  rows_to_process: number;
  model: string | null;
  pricing_available: boolean;
  estimated_cost_usd: Range | null;
  per_row_usd: Range | null;
  basis: 'history' | 'heuristic-no-history';
  assumptions: {
    avg_input_tokens: number;
    output_tokens: Range;
    sampled_rows: number;
    history_rows: number;
  };
  note: string;
}

export type AiEstimateOutcome =
  | { fail: 'not_found' | 'bad_request' | 'no_rows'; message: string }
  | { ok: AiEstimate };

// Target rows this run would touch: the subset, else all existing rows.
// Returns the count plus a small data sample for input-token averaging.
// targetRowIndexes come from resolveRowIdsToIndexes, so they already exist:
// only the sample is read (a sheet can hold a million rows).
function targetRowsAndSample(
  sheetId: string, userId: string, targetRowIndexes: number[] | undefined,
): { count: number; sample: Record<string, string>[] } {
  if (targetRowIndexes && targetRowIndexes.length > 0) {
    const targets = [...new Set(targetRowIndexes)];
    const sampleIdx = targets.slice(0, AI_ESTIMATE_SAMPLE_ROWS);
    const sample = sampleIdx.length === 0 ? [] : (db.prepare(
      `SELECT data FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index IN (${sampleIdx.map(() => '?').join(',')})`,
    ).all(sheetId, userId, ...sampleIdx) as Array<{ data: string }>).map(r => JSON.parse(r.data));
    return { count: targets.length, sample };
  }
  const count = (db.prepare('SELECT COUNT(*) AS c FROM rows WHERE sheet_id = ? AND user_id = ?')
    .get(sheetId, userId) as { c: number }).c;
  const sample = (db.prepare(
    'SELECT data FROM rows WHERE sheet_id = ? AND user_id = ? ORDER BY row_index ASC LIMIT ?',
  ).all(sheetId, userId, AI_ESTIMATE_SAMPLE_ROWS) as Array<{ data: string }>).map(r => JSON.parse(r.data));
  return { count, sample };
}

// Recent completion-token history for THIS model, across the user's runs. p75 is
// the high end (Clay's withholding rank); avg the low end. Thin history (<
// MIN_HISTORY) falls back to a modest typical-cell default.
function outputTokenRange(userId: string, model: string): { range: Range; historyRows: number; basis: AiEstimate['basis'] } {
  const rows = db.prepare(`
    SELECT ar.completion_tokens AS t
    FROM ai_results ar JOIN ai_runs r ON ar.run_id = r.id
    WHERE r.user_id = ? AND r.model = ? AND ar.status = 'completed' AND ar.completion_tokens IS NOT NULL
    ORDER BY ar.created_at DESC LIMIT 500
  `).all(userId, model) as Array<{ t: number }>;
  const tokens = rows.map(r => r.t).filter(t => Number.isFinite(t) && t >= 0);
  if (tokens.length >= AI_ESTIMATE_MIN_HISTORY) {
    const low = Math.round(average(tokens) ?? AI_ESTIMATE_DEFAULT_OUTPUT_TOKENS_LOW);
    const high = Math.max(low, Math.round(percentile(tokens, 75) ?? AI_ESTIMATE_DEFAULT_OUTPUT_TOKENS_HIGH));
    return { range: { low, high }, historyRows: tokens.length, basis: 'history' };
  }
  return {
    range: { low: AI_ESTIMATE_DEFAULT_OUTPUT_TOKENS_LOW, high: AI_ESTIMATE_DEFAULT_OUTPUT_TOKENS_HIGH },
    historyRows: tokens.length, basis: 'heuristic-no-history',
  };
}

export async function estimateAiRun(userId: string, input: AiEstimateInput): Promise<AiEstimateOutcome> {
  const owns = db.prepare('SELECT id FROM sheets WHERE id = ? AND user_id = ?').get(input.sheetId, userId);
  if (!owns) return { fail: 'not_found', message: 'Sheet not found' };

  // Same up-front ref rejection a real run does — never price a prompt that
  // would substitute "[MISSING]" on every row (A9).
  const refsError = unknownPromptRefsError(input.sheetId, userId, input.prompt);
  if (refsError) return { fail: 'bad_request', message: refsError };

  const { count, sample } = targetRowsAndSample(input.sheetId, userId, input.targetRowIndexes);
  if (count === 0) return { fail: 'no_rows', message: 'No rows to process.' };

  // Input tokens: render the prompt against sampled rows (+ system prompt) and
  // average. Free — no API calls.
  const sysTokens = input.systemPrompt ? estimateTokens(input.systemPrompt) : 0;
  const perRowInput = sample.map(d => estimateTokens(processPromptTemplate(input.prompt, d)) + sysTokens);
  const avgInputTokens = Math.round(average(perRowInput) ?? estimateTokens(input.prompt) + sysTokens);

  const model = resolveAiModel(input.model, input.sheetId, userId);
  const out = model
    ? outputTokenRange(userId, model)
    : { range: { low: AI_ESTIMATE_DEFAULT_OUTPUT_TOKENS_LOW, high: AI_ESTIMATE_DEFAULT_OUTPUT_TOKENS_HIGH }, historyRows: 0, basis: 'heuristic-no-history' as const };

  // Pricing: stale cache is fine for a cost hint. Missing model / fetch failure
  // -> pricing_available:false, cost null (never a hard error — the estimate is
  // advisory).
  let pricingAvailable = false;
  let cost: Range | null = null;
  let perRow: Range | null = null;
  if (model) {
    const result = await fetchModels(Date.now());
    const models = result.ok ? result.models : result.stale;
    const m = models?.find(x => x.id === model);
    if (m) {
      pricingAvailable = true;
      const p = parseTokenPrice(m.pricing.prompt);
      const c = parseTokenPrice(m.pricing.completion);
      const rowLow = rowCostUsd(avgInputTokens, out.range.low, p, c);
      const rowHigh = rowCostUsd(avgInputTokens, out.range.high, p, c);
      perRow = { low: roundUsd(rowLow), high: roundUsd(rowHigh) };
      cost = { low: roundUsd(rowLow * count), high: roundUsd(rowHigh * count) };
    }
  }

  const notes: string[] = ['Estimate only — actual cost depends on real token usage.'];
  if (out.basis === 'heuristic-no-history') {
    notes.push('No token history for this model yet; output size is a rough default. Run preview_rows for a measured per-row cost.');
  } else {
    notes.push('Output size estimated from your past runs on this model. Run preview_rows for exact measured cost.');
  }
  if (!model) notes.push('No model resolved — set a model to price this run.');
  else if (!pricingAvailable) notes.push('OpenRouter pricing was unavailable; row count is exact, cost is not shown.');
  if (input.useOpenRouterWebSearch) notes.push('Web search adds provider search costs not reflected here.');

  return {
    ok: {
      rows_to_process: count,
      model,
      pricing_available: pricingAvailable,
      estimated_cost_usd: cost,
      per_row_usd: perRow,
      basis: out.basis,
      assumptions: {
        avg_input_tokens: avgInputTokens,
        output_tokens: out.range,
        sampled_rows: sample.length,
        history_rows: out.historyRows,
      },
      note: notes.join(' '),
    },
  };
}

export interface HttpEstimate {
  rows_to_process: number;
  ai_cost_usd: null;
  note: string;
}

// HTTP enrichment egresses from the user's own API, not an AI model — there is no
// AI dollar cost to price. Report the row count (= outbound calls before caching)
// and the operational caveats.
export function estimateHttpRun(
  userId: string, sheetId: string, targetRowIndexes: number[] | undefined,
): { fail: 'not_found' | 'no_rows'; message: string } | { ok: HttpEstimate } {
  const owns = db.prepare('SELECT id FROM sheets WHERE id = ? AND user_id = ?').get(sheetId, userId);
  if (!owns) return { fail: 'not_found', message: 'Sheet not found' };
  const { count } = targetRowsAndSample(sheetId, userId, targetRowIndexes);
  if (count === 0) return { fail: 'no_rows', message: 'No rows to process.' };
  return {
    ok: {
      rows_to_process: count,
      ai_cost_usd: null,
      note: 'HTTP enrichment runs against your own API (no AI credits). This is one outbound request per row before GET/HEAD caching, subject to your account outbound rate limit.',
    },
  };
}
