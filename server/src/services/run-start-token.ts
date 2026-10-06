// Run starts for the token surfaces (/api/v1 and MCP), in ONE place so the two
// can't drift: REST used to drop estimate_only, preview_rows, output_columns and
// idempotency keys without a word (an "estimate" started a billed run) and skip
// the run-start window. On top of the services the web app uses, a token caller
// gets:
//   - estimate_only: a pure read, never rate-limited;
//   - preview_rows (AI): real calls on a sample, nothing saved;
//   - output_columns (AI): one call per row filling several typed columns;
//   - idempotency_key: a retry with the same key and arguments replays the
//     original run; the same key with different arguments is refused;
//   - the per-token run-start window, shared by both surfaces (startWindow);
//   - an explicit model must exist in the catalog (when it's reachable).
// Callers check the token holds 'run' first. HTTP runs: run-start-token-http.ts.
import { db } from '../lib/db';
import { MAX_ROWS_PER_SHEET } from '../lib/constants';
import { PREVIEW_MAX_ROWS } from '../lib/constants-ai';
import { fetchModels } from '../lib/openrouter';
import { readRunLedger, writeRunLedger, runRequestHash } from '../lib/run-idempotency';
import { parseRunRequest } from '../routes/ai-run-parse';
import { startAiRun } from './ai-run-start';
import { estimateAiRun } from './run-estimate';
import { previewAiRun } from './run-preview';
import { runStartWindow, resolveRowIdsToIndexes, type RunFailKind } from './run-shared';
import { tooManyMessage, type RateDecision } from '../lib/rate-window';
import { parseBooleanOption } from '../lib/web-search-options';
import { webSearchSummary } from '../lib/web-search-plan';

export interface TokenCaller { userId: string; tokenId: string; scopes: Set<string> }
// started: a run was created (REST answers 202); false for an estimate, a
// preview or a replay of an earlier start.
// rate: set on 'rate_limited', so REST can send Retry-After and the window's headers.
export type TokenRunResult =
  | { ok: object; started: boolean }
  | { fail: RunFailKind | 'rate_limited'; message: string; rate?: RateDecision };

export type Fail = { fail: RunFailKind | 'rate_limited'; message: string; rate?: RateDecision };
export const bad = (message: string): Fail => ({ fail: 'bad_request', message });

// Checks shared by both kinds: arguments, sheet, target rows.
export function preamble(c: TokenCaller, a: { sheet_id: unknown; target_row_ids?: unknown; estimate_only?: unknown; idempotency_key?: unknown }):
  Fail | { targetRowIndexes?: number[] } {
  // true/false, or the text "true"/"false" (an MCP client with a stale tool
  // list). null is refused too: read as "not an estimate" it would start a billed run.
  if (a.estimate_only === null || parseBooleanOption(a.estimate_only) === 'invalid') return bad('estimate_only must be true or false');
  if (a.idempotency_key !== undefined && (typeof a.idempotency_key !== 'string' || !a.idempotency_key || a.idempotency_key.length > 200)) {
    return bad('idempotency_key must be a string of 1-200 characters');
  }
  if (typeof a.sheet_id !== 'string' || !db.prepare('SELECT 1 FROM sheets WHERE id = ? AND user_id = ?').get(a.sheet_id, c.userId)) {
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
// typo, or retrying with the same key after a 429, doesn't use up a slot.
export function startWindow(c: TokenCaller): Fail | null {
  const slot = runStartWindow(c.tokenId);
  return slot.allowed ? null : { fail: 'rate_limited', message: tooManyMessage('run starts', slot), rate: slot };
}

// Replay or refuse a repeated idempotency key; null when the start should go ahead.
export function ledgerReplay(c: TokenCaller, key: unknown, hash: string): TokenRunResult | null {
  if (typeof key !== 'string') return null;
  const prior = readRunLedger(c.userId, key, hash);
  if (!prior) return null;
  return 'conflict' in prior
    ? { fail: 'conflict', message: 'Idempotency key was already used with different arguments.' }
    : { ok: { ...prior.replay, replayed: true }, started: false };
}

export interface TokenAiRunArgs {
  sheet_id: unknown; column_name?: unknown; prompt?: unknown; output_columns?: unknown;
  model?: unknown; concurrency?: unknown; system_prompt?: unknown; temperature?: unknown;
  web_search?: unknown; web_fetch?: unknown; max_chars?: unknown; target_row_ids?: unknown;
  estimate_only?: unknown; preview_rows?: unknown; idempotency_key?: unknown;
  search_engine?: unknown; search_mode?: unknown; max_searches_per_row?: unknown;
}

export async function tokenStartAiRun(c: TokenCaller, a: TokenAiRunArgs): Promise<TokenRunResult> {
  const pre = preamble(c, a);
  if ('fail' in pre) return pre;
  const sheetId = a.sheet_id as string;
  if (a.preview_rows !== undefined && !(Number.isInteger(a.preview_rows) && (a.preview_rows as number) >= 1 && (a.preview_rows as number) <= PREVIEW_MAX_ROWS)) {
    return bad(`preview_rows must be a whole number from 1 to ${PREVIEW_MAX_ROWS}`);
  }
  let outputColumns: Array<{ columnName: unknown; type: unknown; description: unknown }> | undefined;
  if (a.output_columns !== undefined) {
    if (!Array.isArray(a.output_columns) || a.output_columns.some(o => !o || typeof o !== 'object')) {
      return bad('output_columns must be an array of { column_name, type, description }');
    }
    outputColumns = (a.output_columns as Array<Record<string, unknown>>).map(o =>
      ({ columnName: o.column_name, type: o.type, description: o.description }));
  }
  const parsed = parseRunRequest({
    sheetId, columnName: a.column_name, prompt: a.prompt, systemPrompt: a.system_prompt,
    model: a.model, temperature: a.temperature, concurrency: a.concurrency, maxChars: a.max_chars,
    useOpenRouterWebSearch: a.web_search, useWebFetch: a.web_fetch, outputColumns,
    searchEngine: a.search_engine, searchMode: a.search_mode, maxSearchesPerRow: a.max_searches_per_row,
  });
  if (!parsed.ok) return bad(parsed.error);
  // A typo'd model used to start a run whose every row failed.
  if (typeof a.model === 'string' && a.model.trim()) {
    const catalog = await fetchModels(Date.now());
    if (catalog.ok && !catalog.models.some(m => m.id === a.model)) {
      return bad(`Unknown model id "${a.model}". Use list_models (MCP) or GET /api/v1/models?search= to find the exact id.`);
    }
  }
  if (parseBooleanOption(a.estimate_only) === true) {
    const est = await estimateAiRun(c.userId, {
      sheetId, prompt: parsed.prompt, systemPrompt: parsed.systemPrompt, model: parsed.model,
      useOpenRouterWebSearch: parsed.useOpenRouterWebSearch, useWebFetch: parsed.useWebFetch,
      outputColumns: parsed.outputColumns, maxChars: parsed.safeMaxChars,
      targetRowIndexes: pre.targetRowIndexes, search: parsed.search,
    });
    return 'fail' in est ? { fail: est.fail === 'not_found' ? 'not_found' : 'bad_request', message: est.message } : { ok: est.ok, started: false };
  }
  if (a.preview_rows !== undefined) {
    const limited = startWindow(c);
    if (limited) return limited;
    const prev = await previewAiRun(c.userId, {
      sheetId, prompt: parsed.prompt, systemPrompt: parsed.systemPrompt, model: parsed.model,
      maxChars: parsed.safeMaxChars, outputColumns: parsed.outputColumns,
      useOpenRouterWebSearch: parsed.useOpenRouterWebSearch, useWebFetch: parsed.useWebFetch,
      previewRows: a.preview_rows as number, targetRowIndexes: pre.targetRowIndexes, search: parsed.search,
    });
    return 'fail' in prev ? { fail: prev.fail === 'no_model' ? 'no_model' : 'bad_request', message: prev.message } : { ok: prev.ok, started: false };
  }
  const hash = runRequestHash('ai_run', {
    sheet_id: sheetId, column_name: a.column_name, prompt: a.prompt, system_prompt: a.system_prompt,
    model: a.model, concurrency: a.concurrency, output_columns: a.output_columns,
    target_row_ids: a.target_row_ids, temperature: a.temperature, max_chars: a.max_chars,
    // Parsed values, so a retry sending "true" (or a cap of "1") replays a start
    // that sent true (or 1) instead of conflicting with it.
    web_search: parsed.useOpenRouterWebSearch, web_fetch: parsed.useWebFetch,
    ...(parsed.useOpenRouterWebSearch ? { search: parsed.search } : {}),
  });
  const replay = ledgerReplay(c, a.idempotency_key, hash);
  if (replay) return replay;
  const limited = startWindow(c);
  if (limited) return limited;
  const result = await startAiRun(c.userId, {
    sheetId, cleanColumnName: parsed.cleanColumnName, prompt: parsed.prompt,
    systemPrompt: parsed.systemPrompt, model: parsed.model,
    useOpenRouterWebSearch: parsed.useOpenRouterWebSearch, useWebFetch: parsed.useWebFetch,
    safeTemperature: parsed.safeTemperature, safeConcurrency: parsed.safeConcurrency,
    safeMaxChars: parsed.safeMaxChars, targetRowIndexes: pre.targetRowIndexes,
    outputColumns: parsed.outputColumns, search: parsed.search,
  });
  if ('fail' in result) return result;
  // With web search: the engine it runs on, priced, and why if Cubex switched it.
  const webSearch = result.ok.webSearch ? { web_search: webSearchSummary(result.ok.webSearch) } : {};
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
  return { ok: payload, started: true };
}
