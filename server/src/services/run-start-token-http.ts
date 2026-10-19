// HTTP run starts for the token surfaces (/api/v1 and MCP): see run-start-token.ts
// for what a token caller gets and why it lives in one place. On top of that,
// the saved-key secrets gate, and estimate_only checks the request template.
// `curl` (a pasted cURL command) stands in for url/method/headers/body; its keys
// follow curl-token.ts, and are saved only once the run is about to start.
import { type HTTPAPIConfig } from '../lib/http-request';
import { HTTP_MAX_CONCURRENCY, HTTP_MAX_TIMEOUT_MS, HTTP_MIN_TIMEOUT_MS } from '../lib/constants';
import { savedKeyRefsInConfig } from '../lib/http-secrets-scan';
import { httpTemplateError } from '../lib/http-template-validate';
import { getSheetColumns } from '../lib/sql-helpers';
import { runRequestHash, writeRunLedger } from '../lib/run-idempotency';
import { startHttpRun } from './http-run-start';
import { estimateHttpRun } from './run-estimate-http';
import { bad, ledgerReplay, preamble, startWindow, type TokenCaller, type TokenRunResult } from './run-start-token';
import { parseBooleanOption } from '../lib/web-search-options';
import { parseRuleField } from '../lib/run-condition';
import { runIfReply } from './run-rule';
import { curlForToken, curlStartProblem, type TokenCurl } from './curl-token';
import { commitCurlKeys } from './curl-import';
import { HTTP_RETRY_MAX, HTTP_STATUS_PATH } from '../lib/constants-http-retry';
import { attachRunWebhook, webhookIdProblem } from './run-hooks-attach';

export interface TokenHttpRunArgs {
  sheet_id: unknown; url?: unknown; method?: unknown; headers?: unknown; body?: unknown;
  response_mapping?: unknown; master_column_name?: unknown; target_row_ids?: unknown;
  estimate_only?: unknown; idempotency_key?: unknown; batch_size?: unknown; timeout_ms?: unknown;
  run_if?: unknown; curl?: unknown; save_keys?: unknown;
  retries?: unknown; retry_post?: unknown; skip_empty_values?: unknown; status_code_column?: unknown;
  webhook_id?: unknown;
}

const wholeIn = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

export async function tokenStartHttpRun(c: TokenCaller, a: TokenHttpRunArgs): Promise<TokenRunResult> {
  const pre = preamble(c, a);
  if ('fail' in pre) return pre;
  const sheetId = a.sheet_id as string;
  let curl: TokenCurl | null = null;
  if (a.curl !== undefined) {
    if ([a.url, a.method, a.headers, a.body].some(v => v !== undefined)) {
      return bad('Pass either curl or url/method/headers/body, not both.');
    }
    const parsed = curlForToken(c, sheetId, a.curl, a.save_keys);
    if ('fail' in parsed) return parsed;
    curl = parsed.ok;
    const rq = curl.prepared.request;
    a = { ...a, url: rq.url, method: rq.method, headers: rq.headers, body: rq.body };
  } else if (a.save_keys !== undefined) {
    return bad('save_keys goes with curl.');
  }
  if (typeof a.url !== 'string' || !a.url.trim()) return bad('url (or curl) is required');
  const method = typeof a.method === 'string' ? a.method.toUpperCase() : 'GET';
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) return bad('method must be GET, POST, PUT or DELETE');
  if (a.headers !== undefined && (!a.headers || typeof a.headers !== 'object' || Array.isArray(a.headers)
    || Object.values(a.headers).some(v => typeof v !== 'string'))) return bad('headers must be an object of strings');
  if (a.body !== undefined && typeof a.body !== 'string') return bad('body must be a string');
  const mapping = a.response_mapping;
  if (!Array.isArray(mapping) || mapping.length === 0
    || mapping.some(m => !m || typeof m.json_path !== 'string' || typeof m.column_name !== 'string')) {
    return bad('response_mapping must be a non-empty array of { json_path, column_name }');
  }
  if (a.master_column_name !== undefined && typeof a.master_column_name !== 'string') return bad('master_column_name must be a string');
  if (a.batch_size !== undefined && !wholeIn(a.batch_size, 1, HTTP_MAX_CONCURRENCY)) {
    return bad(`batch_size must be a whole number from 1 to ${HTTP_MAX_CONCURRENCY}`);
  }
  if (a.timeout_ms !== undefined && !wholeIn(a.timeout_ms, HTTP_MIN_TIMEOUT_MS, HTTP_MAX_TIMEOUT_MS)) {
    return bad(`timeout_ms must be a whole number from ${HTTP_MIN_TIMEOUT_MS} to ${HTTP_MAX_TIMEOUT_MS}`);
  }
  const runIf = parseRuleField(a.run_if, 'run_if');
  if ('error' in runIf) return bad(runIf.error);
  const extras = httpRunExtras(a);
  if (typeof extras === 'string') return bad(extras);
  const hookProblem = webhookIdProblem(c.userId, a.webhook_id);
  if (hookProblem) return bad(hookProblem);
  const config: HTTPAPIConfig = {
    requestConfig: {
      method: method as 'GET', url: a.url, headers: (a.headers as Record<string, string>) ?? {}, body: a.body as string | undefined,
      ...(a.timeout_ms === undefined ? {} : { timeout: a.timeout_ms as number }),
      ...(extras.skipEmpty ? { skipEmpty: true } : {}),
    },
    responseMapping: [
      ...mapping.map((m: { json_path: string; column_name: string }) =>
        ({ jsonPath: m.json_path, columnName: m.column_name })),
      ...(extras.statusColumn ? [{ jsonPath: HTTP_STATUS_PATH, columnName: extras.statusColumn }] : []),
    ],
    previewSize: 3,
    ...(a.batch_size === undefined ? {} : { batchSize: a.batch_size as number }),
    ...(runIf.ok ? { runIf: runIf.ok } : {}),
    ...(extras.retries === undefined ? {} : { retries: extras.retries }),
    ...(extras.retryPost ? { retryPost: true } : {}),
  };
  const hasSecretsScope = c.scopes.has('secrets');
  const keyRefs = savedKeyRefsInConfig(c.userId, config.requestConfig);
  if (keyRefs.length > 0 && !hasSecretsScope) {
    return { fail: 'forbidden', message: `This config references saved API key(s): ${keyRefs.join(', ')}. The access token needs the 'secrets' scope (in addition to 'run').` };
  }
  // A bad URL or {{typo}} fails here, not on every row (and, for a start,
  // before it costs a run-start slot; startHttpRun checks again).
  // Keys a curl is about to save count as known here; they're saved just before the start.
  const toSave = curl?.prepared.keys.map(k => k.name) ?? [];
  const known = [...getSheetColumns(sheetId, c.userId, false), ...toSave];
  const templateError = httpTemplateError(config.requestConfig, known, c.userId);
  if (templateError) return bad(templateError);
  const estimateOnly = parseBooleanOption(a.estimate_only) === true;
  const curlProblem = curl && curlStartProblem(
    c.userId, sheetId, curl, config.responseMapping, a.master_column_name as string | undefined, config.runIf,
    estimateOnly,
  );
  if (curlProblem) return curlProblem;
  if (estimateOnly) {
    const est = await estimateHttpRun(c.userId, sheetId, pre.targetRowIndexes, runIf.ok);
    if ('fail' in est) return { fail: est.fail === 'not_found' ? 'not_found' : 'bad_request', message: est.message };
    const curlPart = curl ? { keys_to_save: [...new Set(toSave)], notes: curl.plan.notes } : {};
    return { ok: { ...est.ok, ...curlPart }, started: false };
  }
  const hash = runRequestHash('http_run', {
    sheet_id: sheetId, url: a.url, method: a.method, headers: a.headers, body: a.body,
    response_mapping: a.response_mapping, master_column_name: a.master_column_name, target_row_ids: a.target_row_ids,
    batch_size: a.batch_size, timeout_ms: a.timeout_ms, ...(runIf.ok ? { run_if: runIf.ok } : {}),
    ...(curl ? { curl: a.curl, save_keys: a.save_keys } : {}),
    // Only when given, so a retry that spans the release still replays.
    ...(extras.retries === undefined ? {} : { retries: extras.retries }),
    ...(extras.retryPost ? { retry_post: true } : {}),
    ...(extras.skipEmpty ? { skip_empty_values: true } : {}),
    ...(extras.statusColumn ? { status_code_column: extras.statusColumn } : {}),
    ...(a.webhook_id ? { webhook_id: a.webhook_id } : {}),
  });
  const replay = ledgerReplay(c, a.idempotency_key, hash);
  if (replay) return replay;
  const limited = startWindow(c, false);
  if (limited) return limited;
  const saved = curl ? commitCurlKeys(c.userId, curl.plan, curl.prepared.keys) : { ok: [] as string[] };
  if ('fail' in saved) return saved;
  const result = await startHttpRun(c.userId, {
    sheetId, config, masterColumnName: a.master_column_name as string | undefined,
    targetRowIndexes: pre.targetRowIndexes, allowSecrets: hasSecretsScope,
  });
  if ('fail' in result) {
    // Saved just before a start that then failed (a run began meanwhile): say so.
    if (saved.ok.length === 0) return result;
    const keys = saved.ok.join(', ');
    return { ...result, message: `${result.message} (Saved as ${saved.ok.length > 1 ? 'keys' : 'a key'}: ${keys}. `
      + `Next time, write {{${saved.ok[0]}}} in the command.)` };
  }
  if (typeof a.webhook_id === 'string') attachRunWebhook('http_runs', result.ok.runId, c.userId, a.webhook_id);
  const payload = {
    run_id: result.ok.runId, master_column: result.ok.masterColumn,
    mapped_columns: result.ok.mappedColumns, target_rows: result.ok.targetCount,
    ...(result.ok.runIf ? runIfReply(result.ok.runIf) : {}),
    ...(curl ? { saved_keys: saved.ok, notes: curl.plan.notes } : {}),
    ...(typeof a.webhook_id === 'string' ? { webhook_id: a.webhook_id } : {}),
  };
  if (typeof a.idempotency_key === 'string') writeRunLedger(c.userId, a.idempotency_key, hash, 'http_run', payload);
  return { ok: payload, started: true };
}

// Retries, empty values and the response code column, checked; a string is why not.
type Extras = { retries?: number; retryPost: boolean; skipEmpty: boolean; statusColumn: string | null };
function httpRunExtras(a: TokenHttpRunArgs): Extras | string {
  if (a.retries !== undefined && !wholeIn(a.retries, 0, HTTP_RETRY_MAX)) {
    return `retries must be a whole number from 0 to ${HTTP_RETRY_MAX}`;
  }
  const retryPost = parseBooleanOption(a.retry_post);
  if (retryPost === 'invalid') return 'retry_post must be true or false';
  const skipEmpty = parseBooleanOption(a.skip_empty_values);
  if (skipEmpty === 'invalid') return 'skip_empty_values must be true or false';
  const col = a.status_code_column;
  if (col !== undefined && col !== null && (typeof col !== 'string' || !col.trim())) {
    return 'status_code_column must be the name of the column to create';
  }
  return {
    ...(a.retries === undefined ? {} : { retries: a.retries as number }),
    retryPost: retryPost === true, skipEmpty: skipEmpty === true,
    statusColumn: typeof col === 'string' ? col.trim() : null,
  };
}
