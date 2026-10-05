import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { touchSheet, jsonPath } from '../lib/sql-helpers';
import { withSheetColumns } from '../lib/http-request-template';
import {
  makeHTTPRequest,
  redactedRequestConfig,
  redactSecrets,
  type HTTPAPIConfig,
} from '../lib/http-request';
import { extractOutcome } from '../lib/jsonpath-extract';
import { getRunStatusAndGen } from './http-runner-status';
import type { HTTPRunRow } from './http-runner-status';
import { httpResultCellValues } from '../lib/http-cell-values';

// True if the worker should stop processing rows. See ai-runner for the
// generation-mismatch rationale (pause/resume race fix).
const shouldStop = (runId: string, capturedGeneration: number): boolean => {
  const cur = getRunStatusAndGen(runId);
  if (cur === null) return true;
  if (cur.status === 'paused' || cur.status === 'cancelled') return true;
  return cur.generation !== capturedGeneration;
};

// Thrown inside the result-write txn when an atomic re-check finds the run is no
// longer ours (cancel/resume raced us). Rolls back; the catch drops it benignly.
const STOP_SENTINEL = Symbol('run-stopped');

// Apply a {columnName: value} map to one row by building a single json_set call.
// Paths are precomputed via jsonPath() so dotted/bracketed column names work.
const writeRowColumns = (
  sheetId: string, userId: string, rowIndex: number,
  values: Array<[string, string]>,
) => {
  if (values.length === 0) return;
  const setExprParts = values.map(() => `?, ?`).join(', ');
  const args: any[] = [];
  for (const [col, val] of values) args.push(jsonPath(col), val);
  args.push(sheetId, userId, rowIndex);
  db.prepare(`
    UPDATE rows SET data = json_set(data, ${setExprParts}),
                    updated_at = datetime('now')
    WHERE sheet_id = ? AND user_id = ? AND row_index = ?
  `).run(...args);
};

// Process a single sheet row: build the request, extract fields, write back into rows.data.
export async function processHTTPRow(
  runId: string,
  row: { rowIndex: number; data: Record<string, string> },
  run: HTTPRunRow,
  config: HTTPAPIConfig,
  signal: AbortSignal | undefined,
  myGeneration: number,
  sheetColumns: string[],
): Promise<void> {
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

  try {
    const responseData = await makeHTTPRequest(config.requestConfig, rowData, run.user_id, signal, allowSavedKeys, runId);
    const extractedFields: Record<string, any> = {};
    for (const mapping of config.responseMapping) {
      // extractOutcome distinguishes "path didn't match" (→ null, normal blank
      // cell) from "path was malformed / threw" (Bug 7: previously swallowed to
      // null → a misleading '⏭️ No data'). A genuinely broken path now FAILS the
      // row (throw → the catch writes '❌ Error' + records the reason) so the user
      // sees a fixable error instead of silent empty data.
      const outcome = extractOutcome(responseData, mapping.jsonPath);
      if (outcome.error) {
        throw new Error(`JSONPath "${mapping.jsonPath}" (column "${mapping.columnName}"): ${outcome.error}`);
      }
      extractedFields[mapping.columnName] = outcome.matched ? outcome.value : null;
    }

    if (shouldStop(runId, myGeneration)) return;

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
        status: 'completed', extractedFields,
        mappingColumns: config.responseMapping.map(m => m.columnName),
        masterColumn: run.master_column_name,
      }));
      writeRowColumns(run.sheet_id, run.user_id, row.rowIndex, writes);
      touchSheet(run.sheet_id, run.user_id);
    }).immediate();
  } catch (error: any) {
    // Our own in-txn stop sentinel: run cancelled/superseded, write rolled back.
    if (error === STOP_SENTINEL) return;
    // Don't record failures caused by an explicit cancel/abort.
    const aborted = error?.name === 'AbortError' || signal?.aborted === true;
    if (aborted || shouldStop(runId, myGeneration)) return;

    const resultId = uuidv4();
    const errorMessage = redactSecrets(error?.message || 'Unknown error');
    // Atomic ownership re-check (see ai-row failure path): .immediate() takes the
    // write lock so the in-txn shouldStop is atomic vs the main-process status
    // UPDATE; skip the writes (return, no throw) if a stop/resume raced us so we
    // don't stamp '❌ Error' into a stopped/superseded run's cells.
    db.transaction(() => {
      if (shouldStop(runId, myGeneration)) return;
      insertResult.run(
        resultId, runId, run.user_id, row.rowIndex,
        redactedConfigJson, null, JSON.stringify({}),
        'failed', errorMessage,
      );
      const writes = Object.entries(httpResultCellValues({
        status: 'failed', extractedFields: {},
        mappingColumns: config.responseMapping.map(m => m.columnName),
        masterColumn: run.master_column_name,
      }));
      writeRowColumns(run.sheet_id, run.user_id, row.rowIndex, writes);
      touchSheet(run.sheet_id, run.user_id);
    }).immediate();
  }
}
