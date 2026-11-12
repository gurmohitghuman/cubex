// run_ai_column's money arguments (MCP and POST /v1/sheets/:id/ai-runs,
// services/run-start-token.ts): max_cost_usd and allow_unpriced, the ceiling
// checked against the estimate before anything starts (lib/cost-ceiling.ts),
// and spend_limit_usd, the run's hard spend limit (services/ai-spend-gate.ts).
// A ceiling is a hard limit too: the run's limit is the lower of the two. Also
// the request hash idempotency keys are checked against, with these fields
// in it only when they are set (so keys from before them still replay).
import { runRequestHash } from '../lib/run-idempotency';
import {
  ceilingArgsOf, ceilingProblem, ceilingView, usdLimitOf, type CeilingArgs, type CeilingFigures,
} from '../lib/cost-ceiling';
import type { AiEstimate } from './run-estimate';
import type { TokenAiRunArgs } from './run-start-token';
import { hasFetchLimits, type FetchLimits } from '../lib/web-fetch-options';

export interface AiRunLimits { ceiling: CeilingArgs; spendLimitUsd: number | null; any: boolean }

export function aiRunLimitsOf(a: { max_cost_usd?: unknown; allow_unpriced?: unknown; spend_limit_usd?: unknown })
  : AiRunLimits | { error: string } {
  const ceiling = ceilingArgsOf(a.max_cost_usd, a.allow_unpriced);
  if ('error' in ceiling) return ceiling;
  const own = usdLimitOf(a.spend_limit_usd, 'spend_limit_usd');
  if ('error' in own) return own;
  const limits = [own.value, ceiling.maxCostUsd].filter((v): v is number => v !== null);
  return {
    ceiling, spendLimitUsd: limits.length ? Math.min(...limits) : null,
    any: own.value !== null || ceiling.maxCostUsd !== null,
  };
}

// What the ceiling reads from an AI estimate: its high end (a model's own web
// fetch in it at up to $0.001 a page: lib/ai-web-cost.ts), what has no price
// (the model, or web search fees Cubex can't price and hasn't measured), and
// one row's most, which the run's spend limit keeps room for (the ceiling is
// that limit).
export function aiCeilingFigures(e: AiEstimate): CeilingFigures {
  const unpriced: string[] = [];
  if (!e.estimated_cost_usd) unpriced.push(e.model ?? 'the model');
  else if (e.web_search && e.web_search.price_per_search_usd === null && e.basis !== 'measured') {
    unpriced.push('web search');
  }
  return { highUsd: e.estimated_cost_usd?.high ?? 0, unpriced, rowMostUsd: e.row_most_usd ?? 0 };
}

// The estimate with the ceiling's outcome, and why a start is refused (null: it may go ahead).
export function aiCeilingCheck(e: AiEstimate, c: CeilingArgs): { estimate: object; problem: string | null } {
  const figures = aiCeilingFigures(e);
  return { estimate: { ...e, ...ceilingView(figures, c) }, problem: ceilingProblem(figures, c) };
}

// The idempotency hash of an AI run start. Parsed values where they matter, so
// a retry sending "true" (or a cap of "1") replays a start that sent true (or 1).
export function aiRunRequestHash(sheetId: string, a: TokenAiRunArgs, parsed: {
  useOpenRouterWebSearch: boolean; useWebFetch: boolean; search: unknown; runIf: string | null | undefined;
  fetchLimits?: FetchLimits;
}, limits: AiRunLimits): string {
  return runRequestHash('ai_run', {
    sheet_id: sheetId, column_name: a.column_name, prompt: a.prompt, system_prompt: a.system_prompt,
    model: a.model, concurrency: a.concurrency, output_columns: a.output_columns,
    target_row_ids: a.target_row_ids, temperature: a.temperature, max_chars: a.max_chars,
    web_search: parsed.useOpenRouterWebSearch, web_fetch: parsed.useWebFetch,
    ...(parsed.useOpenRouterWebSearch ? { search: parsed.search } : {}),
    ...(parsed.runIf ? { run_if: parsed.runIf } : {}),
    // Only when set, so a start without them hashes as before.
    ...(hasFetchLimits(parsed.fetchLimits) ? { fetch_limits: parsed.fetchLimits } : {}),
    ...(a.webhook_id ? { webhook_id: a.webhook_id } : {}),
    ...(limits.ceiling.maxCostUsd !== null ? { max_cost_usd: limits.ceiling.maxCostUsd } : {}),
    // allow_unpriced does nothing without max_cost_usd, so only then does it count.
    ...(limits.ceiling.maxCostUsd !== null && limits.ceiling.allowUnpriced ? { allow_unpriced: true } : {}),
    ...(a.spend_limit_usd !== undefined && a.spend_limit_usd !== null ? { spend_limit_usd: a.spend_limit_usd } : {}),
  });
}
