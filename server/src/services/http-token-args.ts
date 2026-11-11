// An HTTP token start's arguments read on their own, no state (services/run-start-token-http.ts): the retry,
// empty-value and response code options, and the hash a start is known by for its idempotency key.
import { HTTP_RETRY_MAX } from '../lib/constants-http-retry';
import { parseRuleField } from '../lib/run-condition';
import { runRequestHash } from '../lib/run-idempotency';
import { parseBooleanOption } from '../lib/web-search-options';
import { startsRun } from './run-start-token';
import type { TokenHttpRunArgs } from './run-start-token-http';

export const wholeIn = (v: unknown, lo: number, hi: number) =>
  Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

// The hash a start is known by. A cURL command's start has two: of `a` as sent (no url, method, headers or
// body), and of `a` with the request it became once its keys were matched to saved ones (an older key's one).
export function httpRunHash(sheetId: string, a: TokenHttpRunArgs, runIf: string | null, extras: Extras): string {
  return runRequestHash('http_run', {
    sheet_id: sheetId, url: a.url, method: a.method, headers: a.headers, body: a.body,
    response_mapping: a.response_mapping, master_column_name: a.master_column_name, target_row_ids: a.target_row_ids,
    batch_size: a.batch_size, timeout_ms: a.timeout_ms, ...(runIf ? { run_if: runIf } : {}),
    ...(a.curl !== undefined ? { curl: a.curl, save_keys: a.save_keys } : {}),
    // Only when given, so a retry that spans the release still replays.
    ...(extras.retries === undefined ? {} : { retries: extras.retries }),
    ...(extras.retryPost ? { retry_post: true } : {}),
    ...(extras.skipEmpty ? { skip_empty_values: true } : {}),
    ...(extras.statusColumn ? { status_code_column: extras.statusColumn } : {}),
    ...(a.webhook_id ? { webhook_id: a.webhook_id } : {}),
  });
}

// From the arguments alone; null when they don't parse (the start refuses them).
export function httpSentHash(a: TokenHttpRunArgs): string | null {
  if (typeof a.sheet_id !== 'string' || !startsRun(a.estimate_only)) return null;
  const runIf = parseRuleField(a.run_if, 'run_if');
  const extras = httpRunExtras(a);
  return 'error' in runIf || typeof extras === 'string' ? null : httpRunHash(a.sheet_id, a, runIf.ok, extras);
}

// Retries, empty values and the response code column, checked; a string is why not.
export type Extras = { retries?: number; retryPost: boolean; skipEmpty: boolean; statusColumn: string | null };
export function httpRunExtras(a: TokenHttpRunArgs): Extras | string {
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
