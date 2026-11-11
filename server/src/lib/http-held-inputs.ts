// An HTTP API request (an enrichment's or a waterfall's inputs too) that reads a column a run still holds
// (lib/run-locked-columns.ts, counting a stopped or failed run still putting its ⏳ cells back): the rows that
// run hasn't reached hold "⏳ Processing...", and the request would go out with it, billed by an API that charges
// per call. A start, a rerun, a resume and a preview check it before anything is sent (a running row waits:
// services/run-input-gate.ts). What the request reads is what its run reads (lib/run-inputs/columns.ts:
// the {{column}} and /column tokens of the URL, headers and body, by the substitution's own rule), without the
// columns the run writes itself, so a run's own columns never hold up its rerun or its resume (a rerun refuses
// a run still active on its own column by itself: services/http-run-rerun.ts).
import { db } from './db';
import { getSheetColumns } from './sql-helpers';
import { requestRunInputColumns } from './run-inputs/columns';
import { firstHeldRead, heldRefusal, type HeldRead, type HeldRefusal } from './run-held-reads';
import { httpTemplateError } from './http-template-validate';
import type { HTTPAPIConfig } from './http-request-template';

// The refusal, or null when nothing the request reads is held. master: the run's status column ('' for a
// preview, which has none). An enrichment's and a waterfall's inputs are what they read.
export function heldRequestInput(
  sheetId: string, userId: string, config: HTTPAPIConfig, master: string,
): HeldRefusal | null {
  return heldRefusal('The request', firstHeldRead(sheetId, userId,
    () => requestRunInputColumns(config, master, getSheetColumns(sheetId, userId, false))));
}
export const heldRequestInputError = (
  sheetId: string, userId: string, config: HTTPAPIConfig, master: string,
): string | null => heldRequestInput(sheetId, userId, config, master)?.message ?? null;

// A stored request run again (services/http-run-rerun.ts): a column it read may be gone since, or a key
// (lib/http-template-validate.ts), and nothing it reads may be held.
export function storedRequestRefusal(
  sheetId: string, userId: string, config: HTTPAPIConfig, master: string,
): { fail: 'bad_request' | 'conflict'; message: string; held?: HeldRead } | null {
  const templateError = httpTemplateError(config.requestConfig, getSheetColumns(sheetId, userId, false), userId);
  if (templateError) return { fail: 'bad_request', message: templateError };
  const held = heldRequestInput(sheetId, userId, config, master);
  return held ? { fail: 'conflict', message: held.message, held: { column: held.column, hold: held.hold } } : null;
}

// The same check for a paused HTTP API, enrichment or waterfall run about to resume (lib/run-resume-inputs.ts).
export function resumeHeldInputRefusal(runId: string, userId: string): string | null {
  const run = db.prepare(`SELECT sheet_id, config, master_column_name, status FROM http_runs
    WHERE id = ? AND user_id = ?`).get(runId, userId) as
    { sheet_id: string; config: string | null; master_column_name: string | null; status: string } | undefined;
  if (!run || run.status !== 'paused' || !run.config) return null;
  let config: HTTPAPIConfig;
  try { config = JSON.parse(run.config) as HTTPAPIConfig; } catch { return null; }
  return heldRequestInputError(run.sheet_id, userId, config, run.master_column_name ?? '');
}
