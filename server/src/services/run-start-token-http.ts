// HTTP run starts for the token surfaces (/api/v1 and MCP): see run-start-token.ts
// for what a token caller gets and why it lives in one place. On top of that,
// the saved-key secrets gate, and estimate_only checks the request template.
import { type HTTPAPIConfig } from '../lib/http-request';
import { HTTP_MAX_CONCURRENCY, HTTP_MAX_TIMEOUT_MS, HTTP_MIN_TIMEOUT_MS } from '../lib/constants';
import { savedKeyRefsInConfig } from '../lib/http-secrets-scan';
import { httpTemplateError } from '../lib/http-template-validate';
import { getSheetColumns } from '../lib/sql-helpers';
import { runRequestHash, writeRunLedger } from '../lib/run-idempotency';
import { startHttpRun } from './http-run-start';
import { estimateHttpRun } from './run-estimate';
import { bad, ledgerReplay, preamble, startWindow, type TokenCaller, type TokenRunResult } from './run-start-token';

export interface TokenHttpRunArgs {
  sheet_id: unknown; url?: unknown; method?: unknown; headers?: unknown; body?: unknown;
  response_mapping?: unknown; master_column_name?: unknown; target_row_ids?: unknown;
  estimate_only?: unknown; idempotency_key?: unknown; batch_size?: unknown; timeout_ms?: unknown;
}

const wholeIn = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

export async function tokenStartHttpRun(c: TokenCaller, a: TokenHttpRunArgs): Promise<TokenRunResult> {
  const pre = preamble(c, a);
  if ('fail' in pre) return pre;
  const sheetId = a.sheet_id as string;
  if (typeof a.url !== 'string' || !a.url.trim()) return bad('url is required');
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
  const config: HTTPAPIConfig = {
    requestConfig: {
      method: method as 'GET', url: a.url, headers: (a.headers as Record<string, string>) ?? {}, body: a.body as string | undefined,
      ...(a.timeout_ms === undefined ? {} : { timeout: a.timeout_ms as number }),
    },
    responseMapping: mapping.map((m: { json_path: string; column_name: string }) => ({ jsonPath: m.json_path, columnName: m.column_name })),
    previewSize: 3,
    ...(a.batch_size === undefined ? {} : { batchSize: a.batch_size as number }),
  };
  const hasSecretsScope = c.scopes.has('secrets');
  const keyRefs = savedKeyRefsInConfig(c.userId, config.requestConfig);
  if (keyRefs.length > 0 && !hasSecretsScope) {
    return { fail: 'forbidden', message: `This config references saved API key(s): ${keyRefs.join(', ')}. The access token needs the 'secrets' scope (in addition to 'run').` };
  }
  // A bad URL or {{typo}} fails here, not on every row (and, for a start,
  // before it costs a run-start slot; startHttpRun checks again).
  const templateError = httpTemplateError(config.requestConfig, getSheetColumns(sheetId, c.userId, false), c.userId);
  if (templateError) return bad(templateError);
  if (a.estimate_only === true) {
    const est = estimateHttpRun(c.userId, sheetId, pre.targetRowIndexes);
    return 'fail' in est ? { fail: est.fail === 'not_found' ? 'not_found' : 'bad_request', message: est.message } : { ok: est.ok, started: false };
  }
  const hash = runRequestHash('http_run', {
    sheet_id: sheetId, url: a.url, method: a.method, headers: a.headers, body: a.body,
    response_mapping: a.response_mapping, master_column_name: a.master_column_name, target_row_ids: a.target_row_ids,
    batch_size: a.batch_size, timeout_ms: a.timeout_ms,
  });
  const replay = ledgerReplay(c, a.idempotency_key, hash);
  if (replay) return replay;
  const limited = startWindow(c);
  if (limited) return limited;
  const result = await startHttpRun(c.userId, {
    sheetId, config, masterColumnName: a.master_column_name as string | undefined,
    targetRowIndexes: pre.targetRowIndexes, allowSecrets: hasSecretsScope,
  });
  if ('fail' in result) return result;
  const payload = {
    run_id: result.ok.runId, master_column: result.ok.masterColumn,
    mapped_columns: result.ok.mappedColumns, target_rows: result.ok.targetCount,
  };
  if (typeof a.idempotency_key === 'string') writeRunLedger(c.userId, a.idempotency_key, hash, 'http_run', payload);
  return { ok: payload, started: true };
}
