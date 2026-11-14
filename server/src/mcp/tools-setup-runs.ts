import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { MAX_SETUP_TEST_ROWS } from '../lib/constants-setups';
import { RUN_SPEND_LIMIT_MAX_USD } from '../lib/constants';
import { applySetup } from '../services/setup-apply';
import { applyInputOf } from '../services/setup-apply-input';
import { getSetupRun, sheetSetupRuns } from '../services/setup-run-store';
import { controlSetupRun } from '../services/setup-run-control';
import { SHEET_ID, McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';
import { capToolNote } from '../lib/token-spend';

const names = z.record(z.string(), z.string());

// Using a saved setup on a sheet (services/setup-apply.ts, setup-runner.ts):
// apply_setup, get_setup_run, control_setup_run.
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
      + '(carries_on lists them). That is how to fill new rows, or finish a setup that failed or was stopped: call '
      + 'again with the same inputs and names (get_setup_run shows the choices a run used). Auto-run is turned on '
      + 'only after a run on every row. A setup whose requests read saved keys needs the "secrets" scope. '
      + 'COST CEILING: max_cost_usd refuses to start (nothing is created) when the estimate\'s high end, plus one '
      + 'row\'s most for each AI step, is above it, or when a step has no known price unless allow_unpriced is '
      + 'true; the estimate says over_ceiling and ceiling_problem. Once started, each AI and enrichment step gets '
      + 'a spend limit no higher than what is left of the ceiling, so it pauses there. Returns a setup_run with '
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
    return ok(out.ok);
  });

  registerTool(server, 'get_setup_run', {
    description:
      'Where a setup being used on a sheet is: running, paused, done, failed or cancelled, the layer it\'s on, '
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
    return 'ok' in out ? ok(out.ok) : err(out.message);
  });
}
