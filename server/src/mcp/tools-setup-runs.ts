import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import {
  MAX_COLUMN_RUN_COLUMNS, MAX_COLUMN_RUN_ROW_IDS, MAX_SETUP_TEST_ROWS, SETUP_CALL_KEEP_HOURS, SETUP_CALL_MAX_ITEMS,
} from '../lib/constants-setups';
import { RUN_SPEND_LIMIT_MAX_USD } from '../lib/constants';
import { applySetup } from '../services/setup-apply';
import { applyInputOf } from '../services/setup-apply-input';
import { sheetSetupRuns } from '../services/setup-run-store';
import { SETUP_ITEMS, applySetupOnItems, setupRunAnswer } from './setup-items';
import { controlSetupRun } from '../services/setup-run-control';
import { runColumns } from '../services/column-run';
import { COLUMN_RUN_MODES, columnRunInputOf } from '../services/column-run-input';
import { whereLike } from './where-schema';
import {
  SHEET_ID, McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean, type ErrResult, type OkResult,
} from './tool-helpers';
import type { ToolAnswer } from './tool-outputs';
import { changedOf, type Changed } from './changed';

// A setup run's sheet and the columns its steps fill, with work going on.
const setupChanged = (userId: string, run: { sheet_id: string; steps: Array<{ column: string }> }): Changed[] =>
  changedOf(userId, [{ sheetId: run.sheet_id, columns: run.steps.map(s => s.column), moreComing: true }]);
import { capRunToolNote } from '../lib/token-spend';
import { GUIDE_POINTER } from './guides/guide';

const names = z.record(z.string(), z.string());

// Using a saved setup on a sheet (services/setup-apply.ts, setup-runner.ts), or on items without one
// (setup-items.ts): apply_setup, get_run (action setup), control_setup_run; and run_columns, which runs
// a sheet's own run columns on chosen rows as a setup run (services/column-run.ts).
export function registerSetupRunTools(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'apply_setup', {
    description:
      'Build a saved setup\'s columns (list_setups) on a sheet and fill them, each step once the columns it reads '
      + 'are filled: a whole chain of columns on another sheet (for one column, use its own tool). '
      + `ITEMS: with items instead of sheet_id it runs on 1-${SETUP_CALL_MAX_ITEMS} items without a sheet, like a `
      + 'function, for a script or another app: each item is an object keyed by the setup\'s input names. It returns '
      + 'a setup_call, and get_run (action setup) with its id answers each item\'s outputs by column once it finishes. '
      + 'For more '
      + 'items, create_upload_link with setup_id calls it on a file\'s rows. '
      + 'COSTS MONEY: AI steps call your model per row, enrichments spend your treg balance, HTTP API '
      + 'steps send a request per row; clean and formula steps are free. '
      + 'ESTIMATE_ONLY DEFAULTS TO TRUE: the first call prices each step and starts nothing; tell the user, then '
      + 'call again with estimate_only:false. Called again with the same inputs and names, it carries on the '
      + 'columns it made. Auto-run is turned on only after a run on every row. '
      + 'Saved keys in its requests need the "secrets" scope. COST CEILING: max_cost_usd refuses to start (nothing '
      + 'is created) when the estimate\'s high end, plus one row\'s most for each AI step, is above it, or when a '
      + 'step has no known price unless allow_unpriced is true. Returns a setup_run '
      + 'with each step\'s run_id (get_run (action status) works on those); follow it with get_run (action setup). '
      + `A call on items: results are kept ${SETUP_CALL_KEEP_HOURS} hours after it finishes.`
      + capRunToolNote(ctx.spend ?? null) + ` ${GUIDE_POINTER}`,
    inputSchema: z.object({
      sheet_id: z.string().optional().describe(`${SHEET_ID}; or items instead`),
      items: SETUP_ITEMS.optional(),
      setup_id: z.string().describe('The setup (list_setups)'),
      inputs: names.optional()
        .describe('{ "<setup input>": "<column of this sheet>" }; an input left out reads the column of its name'),
      names: names.optional().describe('{ "<step main column>": "<new name>" } (an AI step by its base name), '
        + 'needed when the sheet has a column of that name the step can\'t carry on'),
      models: names.optional().describe('{ "<AI step main column>": "<OpenRouter model id>" }'),
      first_rows: z.number().int().min(1).max(MAX_SETUP_TEST_ROWS).optional()
        .describe(`Test it on the top rows only (1-${MAX_SETUP_TEST_ROWS})`),
      estimate_only: lenientBoolean().optional().describe('Default true: price it, start nothing'),
      webhook_id: z.string().optional().describe(
        'A run webhook (list_run_webhooks) to notify when the setup finishes, signed; poll get_run (action setup) '
          + 'anyway'),
      max_cost_usd: z.number().positive().max(RUN_SPEND_LIMIT_MAX_USD).optional()
        .describe('Refuse to start when the estimate could cost more than this many dollars in all'),
      allow_unpriced: lenientBoolean().optional()
        .describe('With max_cost_usd: start even when a step has no known price (default false)'),
    }).strict(),
  }, async ({ sheet_id, setup_id, items, ...a }) => {
    const denied = missingScope(ctx, 'run');
    if (denied) return denied;
    if (items && sheet_id) return err('Pass sheet_id or items, not both.');
    if (items) return applySetupOnItems(ctx, setup_id, items, a);
    if (!sheet_id) return err('Pass sheet_id (fill a sheet) or items (items without a sheet).');
    const input = applyInputOf(a, 'mcp');
    if ('fail' in input) return err(input.message);
    const out = await applySetup(ctx.userId, sheet_id, setup_id, input, { hasSecretsScope: ctx.scopes.has('secrets') });
    if ('fail' in out) {
      const extra = out.missing ? ` Inputs without a column: ${out.missing.join(', ')}.`
        : out.taken ? ` Names already taken: ${out.taken.join(', ')}.`
        : out.estimate ? ` Estimate: ${JSON.stringify(out.estimate)}` : '';
      return err(out.message + extra);
    }
    // An estimate starts nothing.
    const run = 'setup_run' in out.ok ? out.ok.setup_run : undefined;
    return ok({ ...out.ok, changed: run ? setupChanged(ctx.userId, run) : [] });
  });

  registerTool(server, 'run_columns', {
    description:
      'Run several of a sheet\'s run columns (AI, HTTP API, enrichment, waterfall) again in one call, each with '
      + 'its own settings, on the rows mode picks, among row_ids or the rows a where matches. '
      + 'COSTS MONEY as each column\'s rerun does. ESTIMATE_ONLY DEFAULTS TO TRUE: the first call prices each '
      + 'column and starts nothing; tell the user, then call again with estimate_only:false. max_cost_usd refuses '
      + 'to start (nothing is created) when the estimate could pass it; once started, each AI, enrichment and '
      + 'waterfall column gets a spend limit from what is left. To change a column\'s setup use its own tool. '
      + 'Returns a setup_run: follow it with get_run (action setup); control_setup_run pauses, resumes or stops it.'
      + capRunToolNote(ctx.spend ?? null) + ` ${GUIDE_POINTER}`,
    inputSchema: z.object({
      sheet_id: z.string().describe(SHEET_ID),
      columns: z.array(z.string()).min(1).max(MAX_COLUMN_RUN_COLUMNS)
        .describe('Run columns by name (any column a run fills names that run)'),
      mode: z.enum(COLUMN_RUN_MODES).describe('Rows of each column: empty (never run, or left by its rule), errored '
        + '(❌), out_of_date (made from inputs changed since), empty_or_out_of_date, all (every row again)'),
      row_ids: z.array(z.string()).min(1).max(MAX_COLUMN_RUN_ROW_IDS).optional()
        .describe('Only among these rows (read_rows ids)'),
      where: whereLike('Only among the rows it passes; it may not read a column the run changes.').optional(),
      estimate_only: lenientBoolean().optional().describe('Default true: price it, start nothing'),
      webhook_id: z.string().optional().describe('A run webhook (list_run_webhooks) to notify when it finishes'),
      max_cost_usd: z.number().positive().max(RUN_SPEND_LIMIT_MAX_USD).optional()
        .describe('Refuse to start when the estimate could cost more than this many dollars in all'),
      allow_unpriced: lenientBoolean().optional()
        .describe('With max_cost_usd: start even when a column has no known price (default false)'),
    }).strict(),
  }, async ({ sheet_id, ...a }) => {
    const denied = missingScope(ctx, 'run');
    if (denied) return denied;
    const input = columnRunInputOf(a, 'mcp');
    if ('fail' in input) return err(input.message);
    const out = await runColumns(ctx.userId, sheet_id, input, { hasSecretsScope: ctx.scopes.has('secrets') });
    if ('fail' in out) return err(out.message + (out.estimate ? ` Estimate: ${JSON.stringify(out.estimate)}` : ''));
    const run = 'setup_run' in out.ok ? out.ok.setup_run : undefined;
    return ok({ ...out.ok, changed: run ? setupChanged(ctx.userId, run) : [] });
  });

  registerTool(server, 'control_setup_run', {
    description:
      'Pause, resume or cancel a setup being used on a sheet, or a call on items: the runs of the steps '
      + 'working now follow, and no further step starts. Cancelling keeps the columns and values made so far. '
      + "Resume is refused while a step's AI run is paused at its spend limit (pause_reason spend_limit), which a "
      + "setup can't raise: cancel it and call apply_setup again with a higher max_cost_usd, which carries on where "
      + 'it stopped.',
    inputSchema: z.object({
      setup_run_id: z.string().describe('The setup run (get_run (action setup))'),
      action: z.enum(['pause', 'resume', 'cancel']).describe('What to do with it'),
    }).strict(),
  }, async ({ setup_run_id, action }) => {
    const denied = missingScope(ctx, 'run');
    if (denied) return denied;
    const out = await controlSetupRun(ctx.userId, setup_run_id, action, ctx.scopes.has('secrets'));
    if (!('ok' in out)) return err(out.message);
    // A pause leaves the cells as they are; a resume goes on, a cancel clears its runs' ⏳ cells.
    return ok({ ...out.ok, changed: action === 'pause' ? [] : setupChanged(ctx.userId, out.ok) });
  });
}

// get_run's setup (tools-get-run.ts): a setup run (or a run_columns run, or a call on items) by setup_run_id, with
// a finished call's results paged, waiting up to wait_seconds for it to finish; or a sheet's 5 latest setup runs.
export async function setupRunRead(ctx: McpAuthCtx, a: {
  setup_run_id?: string; sheet_id?: string; setup_id?: string; wait_seconds?: number; results_from?: number;
  limit?: number;
}): Promise<OkResult<ToolAnswer<'get_run'>> | ErrResult> {
  if (a.setup_run_id) {
    return setupRunAnswer(ctx, a.setup_run_id, a.wait_seconds, { from: a.results_from, limit: a.limit });
  }
  if (a.sheet_id) return ok({ setup_runs: sheetSetupRuns(ctx.userId, a.sheet_id, 5, a.setup_id) });
  return err('setup needs setup_run_id or sheet_id.');
}
