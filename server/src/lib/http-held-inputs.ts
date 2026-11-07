// An HTTP API request that reads a column a run still holds (lib/run-locked-columns.ts, counting a stopped or
// failed run still putting its ⏳ cells back): the rows that run hasn't reached hold "⏳ Processing...", and the
// request would go out with it, billed by an API that charges per call. A start, a rerun, a resume and a preview
// check it before anything is sent. What the request reads is what its run reads (lib/run-inputs/columns.ts:
// the {{column}} and /column tokens of the URL, headers and body, by the substitution's own rule), without the
// columns the run writes itself, so a run's own columns never hold up its rerun or its resume (a rerun refuses
// a run still active on its own column by itself: services/http-run-rerun.ts).
import { db } from './db';
import { getSheetColumns } from './sql-helpers';
import { runHeldColumns } from './run-locked-columns';
import { requestRunInputColumns } from './run-inputs/columns';
import { heldReadWords } from './run-held-words';
import { httpTemplateError } from './http-template-validate';
import { isEnrichmentConfig } from './enrich-run-config';
import { isWaterfallConfig } from './waterfall/config';
import type { HTTPAPIConfig } from './http-request-template';

// The refusal, or null when nothing the request reads is held. master: the run's status column ('' for a
// preview, which has none).
export function heldRequestInputError(
  sheetId: string, userId: string, config: HTTPAPIConfig, master: string,
): string | null {
  const held = runHeldColumns(sheetId, userId, { clearing: true });
  if (held.size === 0) return null;
  for (const column of requestRunInputColumns(config, master, getSheetColumns(sheetId, userId, false))) {
    const hold = column === null ? undefined : held.get(column);
    if (column !== null && hold) return heldReadWords('The request', column, hold);
  }
  return null;
}

// A stored request run again (services/http-run-rerun.ts): a column it read may be gone since, or a key
// (lib/http-template-validate.ts), and nothing it reads may be held.
export function storedRequestRefusal(
  sheetId: string, userId: string, config: HTTPAPIConfig, master: string,
): { fail: 'bad_request' | 'conflict'; message: string } | null {
  const templateError = httpTemplateError(config.requestConfig, getSheetColumns(sheetId, userId, false), userId);
  if (templateError) return { fail: 'bad_request', message: templateError };
  const held = heldRequestInputError(sheetId, userId, config, master);
  return held ? { fail: 'conflict', message: held } : null;
}

// The same check for a paused HTTP API run about to resume (services/run-lifecycle.ts resumeRun, and a setup's
// resume before it resumes any of its runs). Enrichment and waterfall runs are left as they were.
export function resumeHeldInputRefusal(kind: 'ai' | 'http', runId: string, userId: string): string | null {
  if (kind !== 'http') return null;
  const run = db.prepare(`SELECT sheet_id, config, master_column_name, status FROM http_runs
    WHERE id = ? AND user_id = ?`).get(runId, userId) as
    { sheet_id: string; config: string | null; master_column_name: string | null; status: string } | undefined;
  if (!run || run.status !== 'paused' || !run.config) return null;
  let config: HTTPAPIConfig;
  try { config = JSON.parse(run.config) as HTTPAPIConfig; } catch { return null; }
  if (isEnrichmentConfig(config) || isWaterfallConfig(config)) return null;
  return heldRequestInputError(run.sheet_id, userId, config, run.master_column_name ?? '');
}

// A rerun by run id (/api/v1 and MCP) asks first, so a refusal takes no run-start slot; rerunHttpColumn checks
// again. Only for the column's newest run: an older one keeps its own refusal (superseded).
export function rerunHeldInputRefusal(runId: string, userId: string): string | null {
  const run = db.prepare('SELECT sheet_id, master_column_name FROM http_runs WHERE id = ? AND user_id = ?')
    .get(runId, userId) as { sheet_id: string; master_column_name: string | null } | undefined;
  if (!run || !run.master_column_name) return null;
  const latest = db.prepare(`SELECT id, config FROM http_runs WHERE sheet_id = ? AND user_id = ?
    AND master_column_name = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(run.sheet_id, userId, run.master_column_name) as { id: string; config: string | null } | undefined;
  if (!latest || latest.id !== runId || !latest.config) return null;
  let config: HTTPAPIConfig;
  try { config = JSON.parse(latest.config) as HTTPAPIConfig; } catch { return null; }
  if (isEnrichmentConfig(config) || isWaterfallConfig(config)) return null;
  return heldRequestInputError(run.sheet_id, userId, config, run.master_column_name);
}
