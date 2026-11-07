// /api/v1 routes: pausing, resuming, cancelling, rerunning and undoing runs,
// and stopping every run on a sheet (api-v1-run-control.ts, api-v1-run-undo.ts,
// api-v1-sheet-ops.ts).
import { z } from 'zod';
import { HTTP_MAX_CONCURRENCY, MAX_FIRST_ROWS, MAX_ROWS_PER_SHEET, RUN_SPEND_LIMIT_MAX_USD } from '../lib/constants';
import { MAX_AI_CONCURRENCY } from '../lib/constants-ai';
import { AI_RERUN_MODES } from '../services/ai-rerun-modes';
import { op, type RouteDoc } from './route-doc';

const RUN_KINDS = [
  { prefix: 'ai-runs', name: 'Ai', what: 'an AI run' },
  { prefix: 'http-runs', name: 'Http', what: 'an HTTP, enrichment or waterfall run' },
] as const;

const rowIds = z.array(z.string()).min(1).max(MAX_ROWS_PER_SHEET).describe('Stable row ids to run again.');
const firstRows = z.number().int().min(1).max(MAX_FIRST_ROWS)
  .describe(`Only among the sheet's first rows (1 to ${MAX_FIRST_ROWS}): all of them, or those mode picks. `
    + 'Not with row_ids.');
const modes = z.enum(AI_RERUN_MODES as [string, ...string[]]);
const webhookId = z.string().optional().describe('A run webhook to tell when the new run finishes.');
const spendLimit = z.number().positive().describe('Enrichment and waterfall runs only: the run limit in USD.');
// An AI run's hard spend limit (lib/cost-ceiling.ts usdLimitOf).
const aiSpendLimit = z.number().positive().max(RUN_SPEND_LIMIT_MAX_USD);
const rerun = { 202: 'The new run: its run_id and how many rows it takes.' };

const controls = (): RouteDoc[] => RUN_KINDS.flatMap(({ prefix, name, what }) => [
  op({
    method: 'post', path: `/${prefix}/{id}/pause`, operationId: `pause${name}Run`, tag: 'control', scope: 'run',
    summary: `Pause ${what}. Answers its status.`,
  }),
  op({
    method: 'post', path: `/${prefix}/{id}/resume`, operationId: `resume${name}Run`, tag: 'control', scope: 'run',
    summary: `Resume ${what}. Answers its status.`,
    ...(prefix === 'ai-runs' ? {
      body: z.object({
        spend_limit_usd: aiSpendLimit.nullable().optional().describe('A new hard spend limit in USD for a paused '
          + 'AI run. For one that paused at its limit (pause_reason spend_limit) it must be above that limit and '
          + 'leave room for what the run spent, calls cut off that may still be billed and the next row; on a run '
          + 'paused another way it adds or changes the limit and must be above what the run spent and its cut-off '
          + 'calls. A lower one is refused (400) with the least that lets it go on. Left out or null, the run keeps '
          + 'its limit.'),
      }),
    } : {}),
    ...(prefix === 'http-runs' ? {
      body: z.object({
        spend_limit_usd: spendLimit.nullable().optional().describe('Enrichment and waterfall runs only: a new run '
          + 'limit in USD, to go on past the one that paused it.'),
        concurrency: z.number().int().min(1).max(HTTP_MAX_CONCURRENCY).optional()
          .describe('Enrichment runs only: rows at once.'),
      }),
    } : {}),
  }),
  op({
    method: 'post', path: `/${prefix}/{id}/cancel`, operationId: `cancel${name}Run`, tag: 'control', scope: 'run',
    summary: `Cancel ${what}. Calls already sent finish. Answers its status.`,
  }),
  op({
    method: 'get', path: `/${prefix}/{id}/undo`, operationId: `get${name}RunUndo`, tag: 'control', scope: 'read',
    summary: `Whether ${what} can be undone, how many rows it wrote, and how far an undo got.`,
  }),
  op({
    method: 'post', path: `/${prefix}/{id}/undo`, operationId: `undo${name}Run`, tag: 'control', scope: 'write',
    summary: `Undo ${what}: put back the cells it wrote. Nothing runs again or is billed.`,
    responses: { 200: 'Undone.', 202: 'A big undo going on in the background. GET it for the counts.' },
  }),
]);

export const runControlRoutes = (): RouteDoc[] => [
  ...controls(),
  op({
    method: 'post', path: '/ai-runs/{id}/rerun', operationId: 'rerunAiRun', tag: 'control', scope: 'run',
    summary: 'Run an AI run again on some of its rows, as a new run that costs again.',
    description: 'Pass row_ids, first_rows or mode. A run that a newer run on its column replaced answers 409.',
    body: z.object({
      row_ids: rowIds.optional(),
      mode: modes.optional().describe('Which rows: errored (failed), empty, missing (empty, failed or unfinished), '
        + 'out_of_date (inputs changed since), empty_or_out_of_date, or all.'),
      first_rows: firstRows.optional(),
      concurrency: z.number().int().min(1).max(MAX_AI_CONCURRENCY).optional()
        .describe(`Rows at once, 1 to ${MAX_AI_CONCURRENCY}. Default: the run's own.`),
      webhook_id: webhookId,
      spend_limit_usd: aiSpendLimit.nullable().optional().describe("The new run's hard spend limit in USD. "
        + "Before each row it checks what the run spent, calls cut off and that row's most at the model's listed "
        + 'prices; with no room left the run pauses (pause_reason spend_limit). Left out or null: no limit.'),
    }),
    responses: rerun,
  }),
  op({
    method: 'post', path: '/http-runs/{id}/rerun', operationId: 'rerunHttpRun', tag: 'control', scope: 'run',
    summary: 'Run an HTTP, enrichment or waterfall run again on some of its rows, as a new run.',
    description: 'An HTTP API run without row_ids or mode runs every row again. An enrichment or waterfall run '
      + "needs row_ids or mode, and only a waterfall column's newest run can run again.",
    body: z.object({
      row_ids: rowIds.optional(),
      mode: modes.optional().describe('Which rows: errored, empty, missing, out_of_date, empty_or_out_of_date or '
        + 'all. On an enrichment or waterfall run, empty means not run yet and missing means no result.'),
      first_rows: firstRows.optional().describe(`HTTP API runs only: the sheet's first rows, 1 to ${MAX_FIRST_ROWS}.`),
      spend_limit_usd: spendLimit.optional(),
      concurrency: z.number().int().min(1).max(HTTP_MAX_CONCURRENCY).optional()
        .describe("Enrichment runs only: rows at once. Default: the run's own."),
      webhook_id: webhookId,
    }),
    responses: rerun,
  }),
  op({
    method: 'get', path: '/sheets/{id}/undo', operationId: 'getColumnUndo', tag: 'control', scope: 'read',
    summary: "A column's newest run that can still be undone, or null.",
    query: z.object({ column: z.string().describe('The run column.') }),
  }),
  op({
    method: 'post', path: '/sheets/{id}/runs/stop', operationId: 'stopSheetRuns', tag: 'control', scope: 'run',
    summary: 'Stop every AI, HTTP and enrichment run on a sheet, and every setup being used on it.',
    description: 'Calls already sent finish and are billed.',
  }),
];
