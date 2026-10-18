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
import { touchSheet } from '../lib/sql-helpers';
import { shouldStop } from './ai-runner-status';
import { STOP_SENTINEL, usageColumns, type RowTokenUsage } from './ai-row-writers';
import { markAutorunInputs } from '../lib/autorun-mark';
import type { RowStamp } from '../lib/run-inputs/stamp';
import { writeRunCells } from '../lib/run-cells-write';

export interface MultiWriteCtx {
  runId: string;
  userId: string;
  sheetId: string;
  rowIndex: number;
  inputValues: string;   // JSON.stringify(row.data)
  statusColumn: string;
  myGeneration: number;
  stamp?: RowStamp;      // what the row's result is made from (lib/run-inputs)
}

const STATUS_OK = '✅';

// The row's cells from ordered (column, value) pairs, and the stamp of the
// inputs they were made from, in one UPDATE.
const writeCells = (ctx: MultiWriteCtx, pairs: Array<[string, string]>) =>
  writeRunCells({ kind: 'ai', id: ctx.runId }, ctx.sheetId, ctx.userId, ctx.rowIndex, pairs, ctx.stamp);

// A run with a web tool also writes its sources: the "(Data)" cell summary and
// the full list for the sources viewer (ai_results.scraped_data).
export interface MultiSources { column: string; summary: string; json: string | null }

// Persist a successful structured row: ai_results (raw JSON as output_value) +
// each output column cell + status ✅ (+ the "(Data)" cell), in one immediate txn.
export function writeMultiSuccess(
  ctx: MultiWriteCtx,
  values: Record<string, string>,
  rawJson: string,
  usage?: RowTokenUsage,
  sources?: MultiSources,
): void {
  const resultId = uuidv4();
  db.transaction(() => {
    if (shouldStop(ctx.runId, ctx.myGeneration)) throw STOP_SENTINEL;
    db.prepare(`
      INSERT INTO ai_results (id, run_id, user_id, row_index, input_values, output_value, status, scraped_data,
        prompt_tokens, completion_tokens, cost_usd, web_searches, web_search_queries, provider_cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?)
    `).run(resultId, ctx.runId, ctx.userId, ctx.rowIndex, ctx.inputValues, rawJson, sources?.json ?? null,
      ...usageColumns(usage));

    const pairs: Array<[string, string]> = Object.entries(values);
    if (sources) pairs.push([sources.column, sources.summary]);
    pairs.push([ctx.statusColumn, STATUS_OK]);
    const wrote = writeCells(ctx, pairs);
    // A column another column's auto-run reads queues this row for it (not
    // once the run was undone: its cells stay as the undo left them).
    const written = [...Object.keys(values), ctx.statusColumn, ...(sources ? [sources.column] : [])];
    if (wrote) markAutorunInputs(ctx.sheetId, ctx.userId, written, { indexes: [ctx.rowIndex] });
    // updated_at only, like the single-column writers: open grids get these cells
    // over SSE (ai-stream.ts). A data_version bump here made every open tab
    // reload the sheet for the whole run (it snapped deep-scrolled viewports).
    touchSheet(ctx.sheetId, ctx.userId);
  }).immediate();
}

// Persist a failed structured row: ai_results 'failed' + status ❌ + every output
// column blanked (so none is stranded on ⏳). No throw on stop (caller is already
// in its catch) — matches writeFailure. usage: set when the call came back (an
// unparseable answer), so the billed call's cost and searches are kept.
export function writeMultiFailure(
  ctx: MultiWriteCtx,
  outputColumns: string[],
  errorMessage: string,
  usage?: RowTokenUsage,
): void {
  const resultId = uuidv4();
  db.transaction(() => {
    if (shouldStop(ctx.runId, ctx.myGeneration)) return;
    db.prepare(`
      INSERT INTO ai_results (id, run_id, user_id, row_index, input_values, output_value, status, error_message,
        prompt_tokens, completion_tokens, cost_usd, web_searches, web_search_queries, provider_cost_usd)
      VALUES (?, ?, ?, ?, ?, '', 'failed', ?, ?, ?, ?, ?, ?, ?)
    `).run(resultId, ctx.runId, ctx.userId, ctx.rowIndex, ctx.inputValues, errorMessage, ...usageColumns(usage));

    const pairs: Array<[string, string]> = outputColumns.map(col => [col, '']);
    pairs.push([ctx.statusColumn, `❌ Error: ${errorMessage}`]);
    writeCells(ctx, pairs);
    touchSheet(ctx.sheetId, ctx.userId);
  }).immediate();
}
