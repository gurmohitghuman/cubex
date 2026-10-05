import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { touchSheet, jsonPath } from '../lib/sql-helpers';
import { shouldStop } from './ai-runner-status';

// Thrown inside the success-path write transaction when a re-check finds the run
// is no longer ours (cancel/resume raced us). Rolls the txn back; processRow's
// catch treats it as a benign drop, never a recorded failure. Exported so the
// orchestrator can distinguish it from a real error.
export const STOP_SENTINEL = Symbol('run-stopped');

// Derive the " (Data)" sibling column name from an AI output column. Handles the
// legacy " (Output)" suffix (replace it) and the bare name (append). Shared by
// both write paths so the success and error cells always target the same column.
export function dataColumnName(columnName: string): string {
  return columnName.endsWith(' (Output)')
    ? columnName.replace(/ \(Output\)$/, ' (Data)')
    : `${columnName} (Data)`;
}

interface WriteCtx {
  runId: string
  userId: string
  sheetId: string
  rowIndex: number
  columnName: string
  inputValues: string  // JSON.stringify(row.data)
  needsDataColumn: boolean
  myGeneration: number
}

// OpenRouter completion.usage, captured per row. NULL when the provider omits
// the usage block. Persisted for measured-cost reporting + history-based
// estimates (see lib/ai-cost.ts). Both fields nullable end-to-end.
export interface RowTokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
}

// Persist a successful row result: ai_results row + the output cell (and the
// (Data) cell for web-search runs) in one .immediate() write transaction.
//
// .immediate() acquires the WRITE lock up front (a plain deferred txn that opens
// with a SELECT wouldn't lock until its first write, leaving a window where a
// pause/cancel UPDATE on the MAIN-process connection commits between our re-check
// and our write — cross-connection WAL). With the lock held, the in-txn
// shouldStop re-check + the writes are atomic vs that UPDATE.
export function writeSuccess(
  ctx: WriteCtx,
  result: string,
  scrapedDataJson: string | null,
  scrapedSummary: string,
  usage?: RowTokenUsage,
): void {
  const resultId = uuidv4();
  const dataColName = dataColumnName(ctx.columnName);
  db.transaction(() => {
    // Re-check under the write lock: the early shouldStop can go stale before we
    // commit (a pause/resume bumps the generation). Throw a sentinel to roll
    // back; processRow's catch treats it as a benign drop, not a run failure.
    if (shouldStop(ctx.runId, ctx.myGeneration)) throw STOP_SENTINEL;
    db.prepare(`
      INSERT INTO ai_results (id, run_id, user_id, row_index, input_values, output_value, status, scraped_data, prompt_tokens, completion_tokens)
      VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)
    `).run(resultId, ctx.runId, ctx.userId, ctx.rowIndex, ctx.inputValues, result, scrapedDataJson,
      usage?.promptTokens ?? null, usage?.completionTokens ?? null);

    if (ctx.needsDataColumn) {
      db.prepare(`
        UPDATE rows SET data = json_set(data, ?, ?, ?, ?),
                        updated_at = datetime('now')
        WHERE user_id = ? AND sheet_id = ? AND row_index = ?
      `).run(
        jsonPath(ctx.columnName), result,
        jsonPath(dataColName), scrapedSummary,
        ctx.userId, ctx.sheetId, ctx.rowIndex,
      );
    } else {
      db.prepare(`
        UPDATE rows SET data = json_set(data, ?, ?),
                        updated_at = datetime('now')
        WHERE user_id = ? AND sheet_id = ? AND row_index = ?
      `).run(
        jsonPath(ctx.columnName), result,
        ctx.userId, ctx.sheetId, ctx.rowIndex,
      );
    }
    touchSheet(ctx.sheetId, ctx.userId);
  }).immediate();
}

// Persist a failed row: ai_results 'failed' row + "❌ Error" cell(s).
//
// Same atomic ownership re-check as writeSuccess: a pause/cancel/resume can land
// between processRow's pre-check and this write, and we must not stamp '❌ Error'
// into a stopped or superseded run's cells. .immediate() takes the write lock so
// the in-txn shouldStop is atomic vs the main-process status UPDATE; if it fires
// we SKIP the writes (return from the txn fn — no throw, since the caller is
// already in its catch and a sentinel would escape processRow).
export function writeFailure(ctx: WriteCtx, errorMessage: string): void {
  const resultId = uuidv4();
  const dataColName = dataColumnName(ctx.columnName);
  db.transaction(() => {
    if (shouldStop(ctx.runId, ctx.myGeneration)) return;
    db.prepare(`
      INSERT INTO ai_results (id, run_id, user_id, row_index, input_values, output_value, status, error_message)
      VALUES (?, ?, ?, ?, ?, '', 'failed', ?)
    `).run(resultId, ctx.runId, ctx.userId, ctx.rowIndex, ctx.inputValues, errorMessage);
    if (ctx.needsDataColumn) {
      db.prepare(`
        UPDATE rows SET data = json_set(data, ?, ?, ?, ?),
                        updated_at = datetime('now')
        WHERE user_id = ? AND sheet_id = ? AND row_index = ?
      `).run(
        jsonPath(ctx.columnName), `❌ Error: ${errorMessage}`,
        jsonPath(dataColName), '❌ Error',
        ctx.userId, ctx.sheetId, ctx.rowIndex,
      );
    } else {
      db.prepare(`
        UPDATE rows SET data = json_set(data, ?, ?),
                        updated_at = datetime('now')
        WHERE user_id = ? AND sheet_id = ? AND row_index = ?
      `).run(
        jsonPath(ctx.columnName), `❌ Error: ${errorMessage}`,
        ctx.userId, ctx.sheetId, ctx.rowIndex,
      );
    }
    touchSheet(ctx.sheetId, ctx.userId);
  }).immediate();
}
