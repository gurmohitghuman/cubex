// Over 200 lines: one AI run start for both token surfaces, its estimate, ceiling, preview and replay, with the
// checks and replays every token start shares.
// Run starts for the token surfaces (/api/v1 and MCP), in ONE place so the two
// can't drift: REST used to drop estimate_only, preview_rows, output_columns and
// idempotency keys without a word (an "estimate" started a billed run) and skip
// the run-start window. On top of the services the web app uses, a token caller
// gets:
//   - estimate_only: a pure read, never rate-limited;
//   - preview_rows (AI): real calls on a sample, nothing saved;
//   - output_columns (AI): one call per row filling several typed columns;
//   - idempotency_key: a retry with the same key and arguments replays the
//     original run, before any check that reads the sheet, its webhooks or the
//     model list (replayFirst); the same key with different arguments is refused;
//   - the per-token run-start window, shared by both surfaces (startWindow);
//   - an explicit model must exist in the catalog (when it's reachable);
//   - max_cost_usd / allow_unpriced (AI): refused before anything starts when
//     the estimate could pass the ceiling, and spend_limit_usd: the run's hard
//     spend limit (the lower of the two; services/run-start-ceiling.ts).
// Callers check the token holds 'run' first. HTTP runs: run-start-token-http.ts.
import { verifySheetOwnership } from '../lib/sql-helpers';
import { MAX_ROWS_PER_SHEET } from '../lib/constants';
import { PREVIEW_MAX_ROWS } from '../lib/constants-ai';
import { modelProblem } from '../lib/ai-model-check';
import { resolveAiConcurrency } from '../lib/ai-model-resolve';
import { readRunLedger, writeRunLedger, type RunLedgerResult } from '../lib/run-idempotency';
import type { ServiceAnswer } from '../mcp/tool-outputs';
import { IDEMPOTENCY_CONFLICT_MESSAGE } from './data-plane-shared';
import { parseRunRequest, type RunParams } from '../routes/ai-run-parse';
import { startAiRun } from './ai-run-start';
import { estimateAiRun } from './run-estimate';
import { previewAiRun } from './run-preview';
import { resolveRowIdsToIndexes, startRefusalMessage, takeRunStart, type RunFailKind } from './run-shared';
import { type RateDecision } from '../lib/rate-window';
import { parseBooleanOption } from '../lib/web-search-options';
import { webSearchSummary } from '../lib/web-search-plan';
import { runIfReply } from './run-rule';
import { attachRunWebhook, webhookIdProblem, webhookIdShapeProblem } from './run-hooks-attach';
import { spendPart } from './token-spend';
import { aiCeilingCheck, aiRunLimitsOf, aiRunRequestHash } from './run-start-ceiling';

export interface TokenCaller { userId: string; tokenId: string; scopes: Set<string> }
// started: a run was created (REST answers 202); false for an estimate, a
// preview or a replay of an earlier start.
// rate: set on 'rate_limited', so REST can send Retry-After and the window's headers.
// estimate: set on 'over_ceiling', the estimate the ceiling refused.
// T: the answer's type, the tool's ToolAnswer for MCP (mcp/tool-outputs.ts), so it is checked against the
// tool's outputSchema at compile time.
export type TokenRunResult<T extends object = object> =
  | { ok: T; started: boolean }
  | { fail: RunFailKind | 'rate_limited'; message: string; rate?: RateDecision; estimate?: object };

export type Fail = { fail: RunFailKind | 'rate_limited'; message: string; rate?: RateDecision };
export const bad = (message: string): Fail => ({ fail: 'bad_request', message });

// Checks shared by both kinds: arguments, sheet, target rows.
export function preamble(c: TokenCaller, a: { sheet_id: unknown; target_row_ids?: unknown; estimate_only?: unknown; idempotency_key?: unknown }):
  Fail | { targetRowIndexes?: number[] } {
  // true/false, or the text "true"/"false" (an MCP client with a stale tool
  // list). null is refused too: read as "not an estimate" it would start a billed run.
  if (a.estimate_only === null || parseBooleanOption(a.estimate_only) === 'invalid') return bad('estimate_only must be true or false');
  if (a.idempotency_key !== undefined && !isIdempotencyKey(a.idempotency_key)) {
    return bad('idempotency_key must be a string of 1-200 characters');
  }
  if (typeof a.sheet_id !== 'string' || !verifySheetOwnership(a.sheet_id, c.userId)) {
    return { fail: 'not_found', message: 'Sheet not found' };
  }
  const raw = a.target_row_ids;
  if (raw === undefined || raw === null) return {};
  if (!Array.isArray(raw) || raw.length === 0 || raw.some(x => typeof x !== 'string')) {
    return bad('target_row_ids must be a non-empty array of row id strings');
  }
  if (raw.length > MAX_ROWS_PER_SHEET) return bad(`target_row_ids is capped at ${MAX_ROWS_PER_SHEET} entries.`);
  const r = resolveRowIdsToIndexes(a.sheet_id, c.userId, raw as string[]);
  return 'error' in r ? bad(r.error) : { targetRowIndexes: r.indexes };
}

// The per-token run-start window, charged only for work that spends (a start
// or a preview), after validation and after an idempotent replay: fixing a
// typo, or retrying with the same key after a 429, doesn't use up a slot. A
// token at its spend cap is refused first (services/token-spend.ts).
export function startWindow(c: TokenCaller, paid = true): Fail | null {
  const refused = takeRunStart(c.userId, c.tokenId, paid);
  if (!refused) return null;
  return 'capped' in refused ? { fail: 'forbidden', message: refused.capped }
    : { fail: 'rate_limited', message: startRefusalMessage(refused), rate: refused.limited };
}

const isIdempotencyKey = (key: unknown): key is string => typeof key === 'string' && !!key && key.length <= 200;

// Replay or refuse a repeated idempotency key; null when the start should go ahead.
// hash: the start's hashes (lib/run-idempotency.ts); either one matching replays.
// A replay is the first start's answer as stored: a start of the same kind (the hash names it) wrote it, so it
// is read back as that start's answer type.
export const replayOf = <T extends object>(stored: RunLedgerResult): T =>
  ({ ...stored, replayed: true }) as unknown as T;

export function ledgerReplay<T extends object = object>(
  c: TokenCaller, key: unknown, hash: string | readonly string[],
): TokenRunResult<T> | null {
  if (typeof key !== 'string') return null;
  const prior = readRunLedger(c.userId, key, hash);
  if (!prior) return null;
  return 'conflict' in prior
    ? { fail: 'conflict', message: IDEMPOTENCY_CONFLICT_MESSAGE }
    : { ok: replayOf<T>(prior.replay), started: false };
}

// A start sent again with its key: the first start's answer, before any check that reads state (the sheet and
// its rows, columns, webhooks, the model list, the tool catalog, held columns, the run-start window), so a retry
// is never refused for what changed since its first call, and takes no run-start slot. Only the token's scopes
// count: a token without 'secrets' whose start needs it gets the start's own checks instead (the saved keys'
// names are read for that alone: run-start-token-http.ts startNeedsSecrets, waterfall-run-start.ts
// replayKeysRefusal). hash: the arguments as the caller sent them. Anything else (no key, a new one, other
// arguments) is null: the start's own checks then run in their order, its ledgerReplay refusing a key used with
// other arguments, as always.
export function firstStart(c: TokenCaller, key: unknown, hash: () => string | null): RunLedgerResult | null {
  if (!isIdempotencyKey(key)) return null;
  let sent: string | null;
  // Arguments nested too deep to hash: no lookup, and the start's own checks refuse them.
  try { sent = hash(); } catch { return null; }
  const prior = sent ? readRunLedger(c.userId, key, sent) : null;
  return prior && 'replay' in prior ? prior.replay : null;
}
export function replayFirst<T extends object = object>(
  c: TokenCaller, key: unknown, hash: () => string | null,
): TokenRunResult<T> | null {
  const prior = firstStart(c, key, hash);
  return prior ? { ok: replayOf<T>(prior), started: false } : null;
}

// true for a start: estimate_only false or left out (a value preamble refuses isn't one).
export function startsRun(estimateOnly: unknown): boolean {
  const v = parseBooleanOption(estimateOnly);
  return estimateOnly !== null && (v === undefined || v === false);
}

export interface TokenAiRunArgs {
  sheet_id: unknown; column_name?: unknown; prompt?: unknown; output_columns?: unknown;
  model?: unknown; concurrency?: unknown; system_prompt?: unknown; temperature?: unknown;
  web_search?: unknown; web_fetch?: unknown; max_chars?: unknown; target_row_ids?: unknown;
  estimate_only?: unknown; preview_rows?: unknown; idempotency_key?: unknown;
  search_engine?: unknown; search_mode?: unknown; max_searches_per_row?: unknown; run_if?: unknown;
  webhook_id?: unknown; max_cost_usd?: unknown; allow_unpriced?: unknown; spend_limit_usd?: unknown;
  max_content_tokens?: unknown; max_pages_per_row?: unknown;
}

// What the arguments say, read as the start reads them (no state): output_columns' shape, then the request.
function aiArgsOf(sheetId: string, a: TokenAiRunArgs): RunParams | { ok: false; error: string } {
  let outputColumns: Array<{ columnName: unknown; type: unknown; description: unknown }> | undefined;
  if (a.output_columns !== undefined) {
    if (!Array.isArray(a.output_columns) || a.output_columns.some(o => !o || typeof o !== 'object')) {
      return { ok: false, error: 'output_columns must be an array of { column_name, type, description }' };
    }
    outputColumns = (a.output_columns as Array<Record<string, unknown>>).map(o =>
      ({ columnName: o.column_name, type: o.type, description: o.description }));
  }
  const parsed = parseRunRequest({
    sheetId, columnName: a.column_name, prompt: a.prompt, systemPrompt: a.system_prompt,
    model: a.model, temperature: a.temperature, concurrency: a.concurrency, maxChars: a.max_chars,
    useOpenRouterWebSearch: a.web_search, useWebFetch: a.web_fetch, outputColumns,
    searchEngine: a.search_engine, searchMode: a.search_mode, maxSearchesPerRow: a.max_searches_per_row,
    runIf: a.run_if, maxContentTokens: a.max_content_tokens, maxPagesPerRow: a.max_pages_per_row,
  });
  return parsed.ok ? parsed : { ok: false, error: parsed.error.replace(/^runIf/, 'run_if') };
}

// The hash a start is known by, from its arguments alone; null when they don't parse (the start refuses them).
function aiSentHash(a: TokenAiRunArgs): string | null {
  if (typeof a.sheet_id !== 'string' || a.preview_rows !== undefined || !startsRun(a.estimate_only)) return null;
  if (webhookIdShapeProblem(a.webhook_id)) return null;
  const parsed = aiArgsOf(a.sheet_id, a);
  const limits = aiRunLimitsOf(a);
  return parsed.ok && !('error' in limits) ? aiRunRequestHash(a.sheet_id, a, parsed, limits) : null;
}

type AiRunAnswer = ServiceAnswer<'run_ai_column'>;

export async function tokenStartAiRun(c: TokenCaller, a: TokenAiRunArgs): Promise<TokenRunResult<AiRunAnswer>> {
  const first = replayFirst<AiRunAnswer>(c, a.idempotency_key, () => aiSentHash(a));
  if (first) return first;
  const pre = preamble(c, a);
  if ('fail' in pre) return pre;
  const sheetId = a.sheet_id as string;
  const rows = a.preview_rows as number | undefined;
  if (rows !== undefined && !(Number.isInteger(rows) && rows >= 1 && rows <= PREVIEW_MAX_ROWS)) {
    return bad(`preview_rows must be a whole number from 1 to ${PREVIEW_MAX_ROWS}`);
  }
  const parsed = aiArgsOf(sheetId, a);
  if (!parsed.ok) return bad(parsed.error);
  const hookProblem = webhookIdProblem(c.userId, a.webhook_id);
  if (hookProblem) return bad(hookProblem);
  const limits = aiRunLimitsOf(a);
  if ('error' in limits) return bad(limits.error);
  if (limits.any && a.preview_rows !== undefined) {
    return bad('max_cost_usd and spend_limit_usd apply to a run, not to preview_rows.');
  }
  // A typo'd model used to start a run whose every row failed. Checked here
  // too (the run's start checks the model it resolves) for the estimate and
  // preview paths, with where to look the id up.
  if (typeof a.model === 'string' && a.model.trim()) {
    const gone = await modelProblem(a.model.trim(),
      'Use list_models (MCP) or GET /api/v1/models?search= to find the exact id.');
    if (gone) return bad(gone);
  }
  // The estimate a ceiling is checked against is the one estimate_only answers.
  const estimate = async () => {
    const est = await estimateAiRun(c.userId, {
      sheetId, prompt: parsed.prompt, systemPrompt: parsed.systemPrompt, model: parsed.model,
      useOpenRouterWebSearch: parsed.useOpenRouterWebSearch, useWebFetch: parsed.useWebFetch,
      outputColumns: parsed.outputColumns, maxChars: parsed.safeMaxChars,
      targetRowIndexes: pre.targetRowIndexes, search: parsed.search, runIf: parsed.runIf,
      concurrency: resolveAiConcurrency(parsed.safeConcurrency, sheetId, c.userId), fetchLimits: parsed.fetchLimits,
      historyColumn: `${parsed.cleanColumnName} ${parsed.outputColumns ? '(Status)' : '(Output)'}`,
    });
    if ('fail' in est) {
      return { fail: est.fail === 'not_found' ? 'not_found' : 'bad_request', message: est.message } as Fail;
    }
    return aiCeilingCheck(est.ok, limits.ceiling);
  };
  if (parseBooleanOption(a.estimate_only) === true) {
    const est = await estimate();
    return 'fail' in est ? est : { ok: est.estimate, started: false };
  }
  if (a.preview_rows !== undefined) {
    const limited = startWindow(c);
    if (limited) return limited;
    const prev = await previewAiRun(c.userId, {
      sheetId, prompt: parsed.prompt, systemPrompt: parsed.systemPrompt, model: parsed.model,
      maxChars: parsed.safeMaxChars, outputColumns: parsed.outputColumns,
      useOpenRouterWebSearch: parsed.useOpenRouterWebSearch, useWebFetch: parsed.useWebFetch,
      previewRows: a.preview_rows as number, targetRowIndexes: pre.targetRowIndexes, search: parsed.search,
      runIf: parsed.runIf, concurrency: resolveAiConcurrency(parsed.safeConcurrency, sheetId, c.userId),
      columnName: parsed.cleanColumnName, fetchLimits: parsed.fetchLimits,
    }, `token:${c.tokenId}`);
    return 'fail' in prev ? { fail: prev.fail === 'no_model' ? 'no_model' : 'bad_request', message: prev.message } : { ok: prev.ok, started: false };
  }
  const hash = aiRunRequestHash(sheetId, a, parsed, limits);
  const replay = ledgerReplay<AiRunAnswer>(c, a.idempotency_key, hash);
  if (replay) return replay;
  // Over the ceiling: refused with the estimate; nothing is created and no run-start slot is taken.
  if (limits.ceiling.maxCostUsd !== null) {
    const checked = await estimate();
    if ('fail' in checked) return checked;
    if (checked.problem) return { fail: 'over_ceiling', message: checked.problem, estimate: checked.estimate };
  }
  const limited = startWindow(c);
  if (limited) return limited;
  const result = await startAiRun(c.userId, {
    sheetId, cleanColumnName: parsed.cleanColumnName, prompt: parsed.prompt,
    systemPrompt: parsed.systemPrompt, model: parsed.model,
    useOpenRouterWebSearch: parsed.useOpenRouterWebSearch, useWebFetch: parsed.useWebFetch,
    safeTemperature: parsed.safeTemperature, safeConcurrency: parsed.safeConcurrency,
    safeMaxChars: parsed.safeMaxChars, targetRowIndexes: pre.targetRowIndexes,
    outputColumns: parsed.outputColumns, search: parsed.search, runIf: parsed.runIf,
    spendLimitUsd: limits.spendLimitUsd, fetchLimits: parsed.fetchLimits,
  });
  if ('fail' in result) return result;
  const hook = typeof a.webhook_id === 'string' ? a.webhook_id : null;
  if (hook) attachRunWebhook('ai_runs', result.ok.runId, c.userId, hook);
  // With web search: the engine it runs on, priced, and why if Cubex switched it.
  const webSearch = {
    ...(result.ok.webSearch ? { web_search: webSearchSummary(result.ok.webSearch) } : {}),
    ...(result.ok.runIf ? runIfReply(result.ok.runIf) : {}),
    ...(hook ? { webhook_id: hook } : {}),
    ...(limits.spendLimitUsd !== null ? { spend_limit_usd: limits.spendLimitUsd } : {}),
  };
  const payload = result.ok.statusColumn ? {
    run_id: result.ok.runId, status_column: result.ok.statusColumn,
    output_columns: result.ok.outputColumns,
    data_column: result.ok.dataColumn ?? null,
    target_rows: result.ok.targetCount, ...webSearch,
  } : {
    run_id: result.ok.runId, output_column: result.ok.outputColumn,
    data_column: result.ok.dataColumn, reused_rows: result.ok.reusedRows, target_rows: result.ok.targetCount,
    ...webSearch,
  };
  if (typeof a.idempotency_key === 'string') writeRunLedger(c.userId, a.idempotency_key, hash, 'ai_run', payload);
  return { ok: { ...payload, ...spendPart(c.userId, c.tokenId) }, started: true };
}
