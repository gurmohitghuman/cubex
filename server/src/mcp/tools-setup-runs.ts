import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { MAX_COLUMN_RUN_COLUMNS, MAX_COLUMN_RUN_ROW_IDS, MAX_SETUP_TEST_ROWS } from '../lib/constants-setups';
import { RUN_SPEND_LIMIT_MAX_USD } from '../lib/constants';
import { applySetup } from '../services/setup-apply';
import { applyInputOf } from '../services/setup-apply-input';
import { getSetupRun, sheetSetupRuns } from '../services/setup-run-store';
import { controlSetupRun } from '../services/setup-run-control';
import { runColumns } from '../services/column-run';
import { COLUMN_RUN_MODES, columnRunInputOf } from '../services/column-run-input';
import { whereLike } from './where-schema';
import { SHEET_ID, McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';
import { changedOf, type Changed } from './changed';

// A setup run's sheet and the columns its steps fill, with work going on.
const setupChanged = (userId: string, run: { sheet_id: string; steps: Array<{ column: string }> }): Changed[] =>
  changedOf(userId, [{ sheetId: run.sheet_id, columns: run.steps.map(s => s.column), moreComing: true }]);
import { capToolNote } from '../lib/token-spend';

const names = z.record(z.string(), z.string());

// Using a saved setup on a sheet (services/setup-apply.ts, setup-runner.ts):
// apply_setup, get_setup_run, control_setup_run; and run_columns, which runs
// a sheet's own run columns on chosen rows as a setup run (services/column-run.ts).
export function registerSetupRunTools(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'apply_setup', {
    description:
      'Build a saved setup\'s columns (save_setup, list_setups) on a sheet and fill them: its steps run in order, '
      + 'each once the columns it reads are filled. Use it to repeat a whole chain of columns on another sheet; '
      + 'for one column use its own tool. COSTS MONEY: AI steps call your model per row, enrichments spend your '
      + 'treg balance, HTTP API steps send a request per row; clean and formula steps are free. ESTIMATE_ONLY '
      + 'DEFAULTS TO TRUE: the first call returns what each step would cost (at most, for steps reading earlier '
      + 'steps) and starts nothing; tell the user, then call again with estimate_only:false. A step whose columns '
      + 'the sheet already has, made by this setup before, CARRIES THEM ON: it fills only the rows it hasn\'t done '
      + '(AI: empty rows; HTTP API: missing; enrichment: not enriched yet; clean and formula follow their columns; '
      + 'carries_on lists them). That is how to fill new rows, or finish a setup that failed or was stopped: call '
      + 'again with the same inputs and names (get_setup_run shows the choices a run used). Auto-run is turned on '
      + 'only after a run on every row. A setup whose requests read saved keys needs the "secrets" scope. '
      + 'COST CEILING: max_cost_usd refuses to start (nothing is created) when the estimate\'s high end, plus one '
      + 'row\'s most for each AI step, is above it, or when a step has no known price unless allow_unpriced is '
      + 'true; the estimate says over_ceiling and ceiling_problem. Once started, each AI and enrichment step gets '
      + 'a spend limit no higher than what is left of the ceiling, so it pauses there; a step with no known price '
      + 'runs without one. Returns a setup_run with '
      + 'each step\'s run_id (get_run_status works on those). Next: get_setup_run to follow the chain.'
      + capToolNote(ctx.spend ?? null, true),
    inputSchema: z.object({
      sheet_id: z.string().describe(SHEET_ID),
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
        'A run webhook (list_run_webhooks) to notify when the setup finishes, signed; poll get_setup_run anyway'),
      max_cost_usd: z.number().positive().max(RUN_SPEND_LIMIT_MAX_USD).optional()
        .describe('Refuse to start when the estimate could cost more than this many dollars in all'),
      allow_unpriced: lenientBoolean().optional()
        .describe('With max_cost_usd: start even when a step has no known price (default false)'),
    }).strict(),
  }, async ({ sheet_id, setup_id, ...a }) => {
    const denied = missingScope(ctx, 'run');
    if (denied) return denied;
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
      + 'its own settings, on the rows mode picks, among row_ids or the rows a where matches. A column reading '
      + 'another chosen column (also through formula, clean or lookup columns) waits for that one\'s whole run. '
      + 'COSTS MONEY as each column\'s rerun does. ESTIMATE_ONLY DEFAULTS TO TRUE: the first call prices each '
      + 'column and starts nothing; tell the user, then call again with estimate_only:false. max_cost_usd refuses '
      + 'to start (nothing is created) when the estimate could pass it; once started, each AI, enrichment and '
      + 'waterfall column gets a spend limit from what is left. To change a column\'s setup use its own tool. '
      + 'Returns a setup_run: follow it with get_setup_run; control_setup_run pauses, resumes or stops it.'
      + capToolNote(ctx.spend ?? null, true),
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

  registerTool(server, 'get_setup_run', {
    description:
      'Where a setup being used on a sheet (or a run_columns run) is: running, paused, done, failed or cancelled, '
      + 'the layer it\'s on, '
      + 'and each step\'s state, run_id and note (why it failed, or that its auto-run wasn\'t turned on), and the '
      + 'choices it was used with. Pass setup_run_id, or sheet_id for the sheet\'s latest ones (with setup_id, '
      + 'that setup\'s). Read-only. Next: control_setup_run, or apply_setup again to carry it on.',
    inputSchema: z.object({
      setup_run_id: z.string().optional().describe('One setup run (apply_setup returned it)'),
      sheet_id: z.string().optional().describe('Or the sheet: its 5 latest setup runs'),
      setup_id: z.string().optional().describe('With sheet_id: only this setup\'s runs'),
    }).strict(),
  }, async ({ setup_run_id, sheet_id, setup_id }) => {
    const denied = missingScope(ctx, 'read');
    if (denied) return denied;
    if (setup_run_id) {
      const run = getSetupRun(ctx.userId, setup_run_id);
      return run ? ok(run) : err('Setup run not found');
    }
    if (sheet_id) return ok({ setup_runs: sheetSetupRuns(ctx.userId, sheet_id, 5, setup_id) });
    return err('Pass setup_run_id or sheet_id.');
  });

  registerTool(server, 'control_setup_run', {
    description:
      'Pause, resume or cancel a setup being used on a sheet: the runs of the steps working now follow, and no '
      + 'further step starts. Cancelling keeps the columns and values made so far. Resume is refused while a '
      + "step's AI run is paused at its spend limit (pause_reason spend_limit), which a setup can't raise: cancel "
      + 'it and call apply_setup again with a higher max_cost_usd, which carries on where it stopped.',
    inputSchema: z.object({
      setup_run_id: z.string().describe('The setup run (get_setup_run)'),
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
