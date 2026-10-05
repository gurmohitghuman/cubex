// Pure cost / token math for estimate_only + measured-cost reporting. No DB, no
// network — the estimate service (services/run-estimate.ts) and preview supply
// the inputs. Kept separate so the arithmetic is unit-testable and the service
// stays about orchestration.
import { AI_ESTIMATE_CHARS_PER_TOKEN } from './constants-ai';

// OpenRouter pricing arrives as decimal-STRING dollars-per-token ("0.0000015"),
// sometimes "0" (free models) or absent. Parse defensively: a non-finite or
// negative value means "unknown" -> 0, never NaN (which would poison every sum).
export function parseTokenPrice(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// Rough token count from character length. Real tokenization is model-specific;
// chars/4 is the standard back-of-envelope and is only ever used for the INPUT
// side of an estimate (output uses measured history). Never negative.
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / AI_ESTIMATE_CHARS_PER_TOKEN);
}

// 75th percentile (nearest-rank) of a numeric sample. Clay withholds credits at
// p75 of past runs; we use it as the HIGH end of the output-token range. Returns
// null for an empty sample so callers fall back to the heuristic default.
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
}

export function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Dollar cost of one row = input_tokens * prompt_price + output_tokens *
// completion_price. Both prices are per-token.
export function rowCostUsd(
  inputTokens: number, outputTokens: number, promptPrice: number, completionPrice: number,
): number {
  return inputTokens * promptPrice + outputTokens * completionPrice;
}

// Round a dollar amount for display without ever showing a real cost as $0.00:
// tiny non-zero costs keep enough significant digits to stay legible.
export function roundUsd(value: number): number {
  if (value === 0) return 0;
  if (value < 0.01) return Number(value.toPrecision(2));
  return Number(value.toFixed(2));
}
