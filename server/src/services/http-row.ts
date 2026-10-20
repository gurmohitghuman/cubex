import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { touchSheet } from '../lib/sql-helpers';
import { withSheetColumns } from '../lib/http-request-template';
import {
  sendHTTPRequest,
  redactedRequestConfig,
  redactSecrets,
  type HTTPAPIConfig,
} from '../lib/http-request';
import { extractMappedFields, failedRowFields, statusColumnsOf } from '../lib/http-extract-fields';
import { responseStatusOf, withResponseStatus } from '../lib/http-errors';
import { nextRetryWait, retryPolicyOf, tryFailureOf, waitUnlessStopped } from '../lib/http-retry';
import { shouldStopHttpRun, writeRowColumns } from './run-row-write';
import type { HTTPRunRow } from './http-runner-status';
import { httpResultCellValues } from '../lib/http-cell-values';
import type { RunRow } from '../lib/run-rows';
import { DONE, DROPPED, httpProviderSide, type RowOutcome } from '../lib/run-breaker';
import { isStorageFailure } from '../lib/storage-failure';

const shouldStop = shouldStopHttpRun;

// Thrown inside the result-write txn when an atomic re-check finds the run is no
// longer ours (cancel/resume raced us). Rolls back; the catch drops it benignly.
const STOP_SENTINEL = Symbol('run-stopped');

// Process a single sheet row: build the request, extract fields, write back
// into rows.data. Says what the row came to (the runner's brake counts provider
// failures in a row); throws only when the database can't be written.
export async function processHTTPRow(
  runId: string,
  row: RunRow,
  run: HTTPRunRow,
  config: HTTPAPIConfig,
  signal: AbortSignal | undefined,
  myGeneration: number,
  sheetColumns: string[],
): Promise<RowOutcome> {
  // Upsert on the (run_id, row_index) unique key (migration 028): a re-write of
  // the SAME run+row is an idempotent overwrite, not a duplicate. (Reruns use a
  // NEW run_id, so they never collide here.) Belt-and-suspenders behind the
  // runner's placeholder-filter fix — neither path can leave two result rows.
  const insertResult = db.prepare(`
    INSERT INTO http_results (
      id, run_id, user_id, row_index, request_config, response_data, extracted_fields, status, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, row_index) DO UPDATE SET
      request_config = excluded.request_config,
      response_data = excluded.response_data,
      extracted_fields = excluded.extracted_fields,
      status = excluded.status,
      error_message = excluded.error_message,
      updated_at = datetime('now')
  `);

  // Run-level secret policy (migration 034): a run authored/operated without
  // the 'secrets' scope must never resolve saved api_keys, even ones created
  // after its start-time scan passed. 0 disables the fallback; NULL/1 allow it.
  //
  // Two layers, both required: (1) the once-captured boolean is the fast
  // pre-filter for the START-time frozen policy; (2) passing runId makes each
  // key lookup re-check allow_secrets in the SAME atomic SQL statement, closing
  // the RESUME-freeze TOCTOU (a no-'secrets' resume commits allow_secrets→0
  // from the API thread while this worker thread is mid-substitution; a
  // boolean captured before the key lookup could be stale, but the atomic
  // lookup can't be — see lookupApiKey).
  const allowSavedKeys = run.allow_secrets !== 0;

  // Persist a REDACTED copy of the request config — any /api_key_name token becomes
  // "[REDACTED:<name>]" so the user's real Bearer token never lands in
  // http_results.request_config (which is auth-scoped but otherwise survives forever).
  // This is a SEPARATE atomic lookup from the live request's (both pass runId, so
  // both re-check allow_secrets). A resume-freeze landing between the two can make
  // this record show "[REDACTED:key]" while the live request no longer injected the
  // key — an accepted audit-fidelity gap, NOT a leak: the divergence is always in
  // the safe direction (the record can over-state redaction, never expose a real
  // key value). Coupling them perfectly would need a txn around the outbound call.
  const rowData = withSheetColumns(row.data, sheetColumns);
  const redactedConfigJson = JSON.stringify(
    redactedRequestConfig(config.requestConfig, rowData, run.user_id, allowSavedKeys, runId),
  );

  const mappingColumns = config.responseMapping.map(m => m.columnName);
  const statusColumns = statusColumnsOf(config.responseMapping);
  try {
    const answer = await sendWithRetries(runId, myGeneration, config, rowData, run.user_id, signal, allowSavedKeys);
    if (answer === STOPPED) return DROPPED;
    const responseData = answer.data;
    // A path that didn't match is a blank cell; a malformed one (Bug 7: once
    // swallowed to a misleading '⏭️ No data') FAILS the row with a fixable
    // message, and the response code column still shows what the API answered.
    let extractedFields: Record<string, any>;
    try { extractedFields = extractMappedFields(responseData, answer.status, config.responseMapping); }
    catch (error) { throw withResponseStatus(error, answer.status); }

    if (shouldStop(runId, myGeneration)) return DROPPED;

    const resultId = uuidv4();

    db.transaction(() => {
      // Atomic re-check: the early shouldStop can go stale before this synchronous
      // txn commits. Throw to roll back if a cancel/resume raced us. See ai-row.
      if (shouldStop(runId, myGeneration)) throw STOP_SENTINEL;
      insertResult.run(
        resultId, runId, run.user_id, row.rowIndex,
        redactedConfigJson, JSON.stringify(responseData), JSON.stringify(extractedFields),
        'completed', null,
      );
      // Shared with the SSE stream (http-jobs.ts) so live cells == persisted cells.
      const writes = Object.entries(httpResultCellValues({
        status: 'completed', extractedFields, mappingColumns, statusColumns,
        masterColumn: run.master_column_name,
      }));
      writeRowColumns(run.id, run.sheet_id, run.user_id, row.rowIndex, writes, row.stamp);
      touchSheet(run.sheet_id, run.user_id);
    }).immediate();
    return DONE;
  } catch (error: any) {
    // Our own in-txn stop sentinel: run cancelled/superseded, write rolled back.
    if (error === STOP_SENTINEL) return DROPPED;
    // Nothing can be saved: the runner stops sending requests.
    if (isStorageFailure(error)) throw error;
    // Don't record failures caused by an explicit cancel/abort.
    const aborted = error?.name === 'AbortError' || signal?.aborted === true;
    if (aborted || shouldStop(runId, myGeneration)) return DROPPED;

    const resultId = uuidv4();
    const errorMessage = redactSecrets(error?.message || 'Unknown error');
    // The status code when the API answered: kept for the response code column.
    const failedFields = failedRowFields(responseStatusOf(error), config.responseMapping);
    // Atomic ownership re-check (see ai-row failure path): .immediate() takes the
    // write lock so the in-txn shouldStop is atomic vs the main-process status
    // UPDATE; skip the writes (return, no throw) if a stop/resume raced us so we
    // don't stamp '❌ Error' into a stopped/superseded run's cells.
    db.transaction(() => {
      if (shouldStop(runId, myGeneration)) return;
      insertResult.run(
        resultId, runId, run.user_id, row.rowIndex,
        redactedConfigJson, null, JSON.stringify(failedFields),
        'failed', errorMessage,
      );
      const writes = Object.entries(httpResultCellValues({
        status: 'failed', extractedFields: failedFields, mappingColumns, statusColumns,
        masterColumn: run.master_column_name,
      }));
      writeRowColumns(run.id, run.sheet_id, run.user_id, row.rowIndex, writes, row.stamp);
      touchSheet(run.sheet_id, run.user_id);
    }).immediate();
    return { kind: 'failed', message: errorMessage, provider: httpProviderSide(tryFailureOf(error)) };
  }
}

const STOPPED = Symbol('stopped-while-waiting');

// The row's request, tried again on a failure a retry can fix (lib/http-retry.ts)
// while the column's retries last. Each try starts from the top: cache check →
// SSRF guard → request. The row keeps its slot while it waits, so the run's
// concurrency holds; a pause or stop during a wait leaves the row ⏳ for its
// run (STOPPED). A failure that isn't retried, or the last one, is thrown with
// how many tries it took.
async function sendWithRetries(
  runId: string, myGeneration: number, config: HTTPAPIConfig, rowData: Record<string, string>, userId: string,
  signal: AbortSignal | undefined, allowSavedKeys: boolean,
): Promise<{ data: any; status: number } | typeof STOPPED> {
  const policy = retryPolicyOf(config);
  const method = config.requestConfig.method || 'GET';
  for (let attempt = 1; ; attempt++) {
    try {
      return await sendHTTPRequest(config.requestConfig, rowData, userId, signal, allowSavedKeys, runId);
    } catch (error: any) {
      if (error?.name === 'AbortError' || signal?.aborted) throw error;
      const wait = nextRetryWait(tryFailureOf(error), method, attempt, policy, Date.now());
      if (wait === null) {
        if (attempt > 1 && error instanceof Error) error.message = `${error.message} (tried ${attempt} times)`;
        throw error;
      }
      if (!await waitUnlessStopped(wait, () => shouldStop(runId, myGeneration), signal)) return STOPPED;
    }
  }
}
