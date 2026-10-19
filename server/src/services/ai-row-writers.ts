import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { touchSheet } from '../lib/sql-helpers';
import { shouldStop } from './ai-runner-status';
import { markAutorunInputs } from '../lib/autorun-mark';
import type { RowStamp } from '../lib/run-inputs/stamp';
import { writeRunCells } from '../lib/run-cells-write';
import { redactError } from '../lib/redact';

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
  stamp?: RowStamp     // what the row's result is made from (lib/run-inputs)
}

// The row's cells, and the stamp of the inputs they were made from, in one UPDATE.
const writeCells = (ctx: WriteCtx, cells: Array<[string, string]>) =>
  writeRunCells({ kind: 'ai', id: ctx.runId }, ctx.sheetId, ctx.userId, ctx.rowIndex, cells, ctx.stamp);

// OpenRouter completion.usage, captured per row. NULL when the provider omits
// the usage block. Persisted for measured-cost reporting + history-based
// estimates (see lib/ai-cost.ts). Every field nullable end-to-end.
export interface RowTokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  // What OpenRouter charged for the row (usage.cost), web fees included. Kept
  // on a failed row too when its call came back: that call was still billed.
  costUsd?: number | null;
  // On the user's own provider key (BYOK): what that provider charged.
  providerCostUsd?: number | null;
  // With web search on: the searches that ran, and every search call as JSON
  // [{query, ran}] (lib/responses-adapter.ts). null without web search.
  webSearches?: number | null;
  searchQueries?: string | null;
}

// The ai_results spend columns, in INSERT order: tokens, cost, searches, queries, provider cost.
export const usageColumns = (u?: RowTokenUsage) => [
  u?.promptTokens ?? null, u?.completionTokens ?? null, u?.costUsd ?? null,
  u?.webSearches ?? null, u?.searchQueries ?? null, u?.providerCostUsd ?? null,
];

// A call that came back (billed) for a row a pause, cancel or resume then
// dropped: the row writes nothing, but what the call cost still counts on the
// run's usage record and so on its access token's spend cap (migration 045's
// trigger). Call it once per dropped call, on every stop path after the call
// came back. Never throws: inside a writer's transaction it's part of that
// transaction; outside one, a record that fails is logged.
export function recordDroppedCall(ctx: { runId: string; userId: string }, usage?: RowTokenUsage): void {
  if (!usage || (!usage.costUsd && !usage.providerCostUsd)) return;
  try {
    db.prepare(`INSERT INTO ai_dropped_calls (id, run_id, user_id, cost_usd, provider_cost_usd)
      VALUES (?, ?, ?, ?, ?)`)
      .run(uuidv4(), ctx.runId, ctx.userId, usage.costUsd ?? null, usage.providerCostUsd ?? null);
  } catch (error) {
    console.error(`Recording what a dropped row's call cost (run ${ctx.runId}) failed:`, redactError(error));
  }
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
      INSERT INTO ai_results (id, run_id, user_id, row_index, input_values, output_value, status, scraped_data,
        prompt_tokens, completion_tokens, cost_usd, web_searches, web_search_queries, provider_cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      resultId, ctx.runId, ctx.userId, ctx.rowIndex, ctx.inputValues, result, scrapedDataJson,
      ...usageColumns(usage),
    );

    const wrote = writeCells(ctx, ctx.needsDataColumn
      ? [[ctx.columnName, result], [dataColName, scrapedSummary]] : [[ctx.columnName, result]]);
    // A column another column's auto-run reads queues this row for it (not
    // once the run was undone: its cells stay as the undo left them).
    const written = ctx.needsDataColumn ? [ctx.columnName, dataColName] : [ctx.columnName];
    if (wrote) markAutorunInputs(ctx.sheetId, ctx.userId, written, { indexes: [ctx.rowIndex] });
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
// already in its catch and a sentinel would escape processRow), keeping only
// what a call that came back cost (recordDroppedCall).
// usage: set when the call came back and the answer was unusable (a refusal,
// the token limit): what that billed call cost and searched.
export function writeFailure(ctx: WriteCtx, errorMessage: string, usage?: RowTokenUsage): void {
  const resultId = uuidv4();
  const dataColName = dataColumnName(ctx.columnName);
  db.transaction(() => {
    if (shouldStop(ctx.runId, ctx.myGeneration)) { recordDroppedCall(ctx, usage); return; }
    db.prepare(`
      INSERT INTO ai_results (id, run_id, user_id, row_index, input_values, output_value, status, error_message,
        prompt_tokens, completion_tokens, cost_usd, web_searches, web_search_queries, provider_cost_usd)
      VALUES (?, ?, ?, ?, ?, '', 'failed', ?, ?, ?, ?, ?, ?, ?)
    `).run(resultId, ctx.runId, ctx.userId, ctx.rowIndex, ctx.inputValues, errorMessage, ...usageColumns(usage));
    const failed = `❌ Error: ${errorMessage}`;
    writeCells(ctx, ctx.needsDataColumn
      ? [[ctx.columnName, failed], [dataColName, '❌ Error']] : [[ctx.columnName, failed]]);
    touchSheet(ctx.sheetId, ctx.userId);
  }).immediate();
}
