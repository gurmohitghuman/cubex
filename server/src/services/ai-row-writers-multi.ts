// Transactional writers for structured multi-column AI rows. Sibling of
// ai-row-writers.ts (single-column). Both use .immediate() so the in-txn
// shouldStop re-check is atomic vs a cross-connection pause/cancel UPDATE.
//
// LOAD-BEARING: every write MUST overwrite the STATUS column's '⏳ Processing...'
// placeholder (success → ✅, failure → ❌). The resume filter and finalizeStatus
// key off the status column (= ai_runs.column_name); a row whose status stays ⏳
// gets reprocessed (re-billed) on resume and blocks completion. On failure the
// output columns are blanked too, so no cell is stranded on the spinner.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { touchSheet, jsonPath } from '../lib/sql-helpers';
import { shouldStop } from './ai-runner-status';
import { STOP_SENTINEL } from './ai-row-writers';
import type { RowTokenUsage } from './ai-row-writers';

export interface MultiWriteCtx {
  runId: string;
  userId: string;
  sheetId: string;
  rowIndex: number;
  inputValues: string;   // JSON.stringify(row.data)
  statusColumn: string;
  myGeneration: number;
}

const STATUS_OK = '✅';

// json_set(data, p1, v1, p2, v2, ...) built from ordered (path, value) pairs.
function jsonSetPairs(pairs: Array<[string, string]>): { expr: string; args: string[] } {
  const expr = 'json_set(data' + pairs.map(() => ', ?, ?').join('') + ')';
  const args: string[] = [];
  for (const [path, value] of pairs) args.push(path, value);
  return { expr, args };
}

// Persist a successful structured row: ai_results (raw JSON as output_value) +
// each output column cell + status ✅, in one immediate txn.
export function writeMultiSuccess(
  ctx: MultiWriteCtx,
  values: Record<string, string>,
  rawJson: string,
  usage?: RowTokenUsage,
): void {
  const resultId = uuidv4();
  db.transaction(() => {
    if (shouldStop(ctx.runId, ctx.myGeneration)) throw STOP_SENTINEL;
    db.prepare(`
      INSERT INTO ai_results (id, run_id, user_id, row_index, input_values, output_value, status, prompt_tokens, completion_tokens)
      VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?)
    `).run(resultId, ctx.runId, ctx.userId, ctx.rowIndex, ctx.inputValues, rawJson,
      usage?.promptTokens ?? null, usage?.completionTokens ?? null);

    const pairs: Array<[string, string]> = Object.entries(values).map(([col, val]) => [jsonPath(col), val]);
    pairs.push([jsonPath(ctx.statusColumn), STATUS_OK]);
    const { expr, args } = jsonSetPairs(pairs);
    db.prepare(`
      UPDATE rows SET data = ${expr}, updated_at = datetime('now')
      WHERE user_id = ? AND sheet_id = ? AND row_index = ?
    `).run(...args, ctx.userId, ctx.sheetId, ctx.rowIndex);
    touchSheet(ctx.sheetId, ctx.userId);
  }).immediate();
}

// Persist a failed structured row: ai_results 'failed' + status ❌ + every output
// column blanked (so none is stranded on ⏳). No throw on stop (caller is already
// in its catch) — matches writeFailure.
export function writeMultiFailure(
  ctx: MultiWriteCtx,
  outputColumns: string[],
  errorMessage: string,
): void {
  const resultId = uuidv4();
  db.transaction(() => {
    if (shouldStop(ctx.runId, ctx.myGeneration)) return;
    db.prepare(`
      INSERT INTO ai_results (id, run_id, user_id, row_index, input_values, output_value, status, error_message)
      VALUES (?, ?, ?, ?, ?, '', 'failed', ?)
    `).run(resultId, ctx.runId, ctx.userId, ctx.rowIndex, ctx.inputValues, errorMessage);

    const pairs: Array<[string, string]> = outputColumns.map(col => [jsonPath(col), '']);
    pairs.push([jsonPath(ctx.statusColumn), `❌ Error: ${errorMessage}`]);
    const { expr, args } = jsonSetPairs(pairs);
    db.prepare(`
      UPDATE rows SET data = ${expr}, updated_at = datetime('now')
      WHERE user_id = ? AND sheet_id = ? AND row_index = ?
    `).run(...args, ctx.userId, ctx.sheetId, ctx.rowIndex);
    touchSheet(ctx.sheetId, ctx.userId);
  }).immediate();
}
