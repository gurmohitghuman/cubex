import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MAX_SETUP_TEST_ROWS } from '../lib/constants-setups';
import { applySetup } from '../services/setup-apply';
import { applyInputOf } from '../services/setup-apply-input';
import { getSetupRun, sheetSetupRuns } from '../services/setup-run-store';
import { controlSetupRun } from '../services/setup-run-control';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';

const names = z.record(z.string(), z.string());

// Using a saved setup on a sheet (services/setup-apply.ts, setup-runner.ts):
// apply_setup, get_setup_run, control_setup_run.
export function registerSetupRunTools(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'apply_setup', {
    description:
      'Build a saved setup\'s columns on a sheet and fill them: its steps run in order, each once the columns it '
      + 'reads are filled (AI steps call your AI model per row and enrichments spend your treg balance; HTTP API '
      + 'steps send a request per row; clean and formula steps are free). ESTIMATE_ONLY DEFAULTS TO TRUE: the '
      + 'first call returns what each step would cost on the sheet\'s rows (at most, for steps reading earlier '
      + 'steps) and starts nothing; tell the user, then call again with estimate_only: false to start. inputs '
      + 'maps each of the setup\'s inputs (list_setups) to a column of this sheet; an input left out uses the '
      + 'column of the same name. A step whose columns the sheet has already, made the same way (by this setup '
      + 'before), CARRIES THEM ON: it fills only the rows it hasn\'t done, with the column\'s own settings (AI: '
      + 'empty rows; HTTP API: missing; enrichment: not enriched yet; clean and formula follow their columns). '
      + 'That is how to fill new rows, or finish a setup that failed or was stopped: call it again with the same '
      + 'inputs and names (get_setup_run shows the choices a run used); carries_on lists those steps. names gives '
      + 'a step\'s main column another name (an AI step by its base name), needed when the sheet has a column of '
      + 'that name the step can\'t carry on. models picks the model of a new AI step. '
      + `first_rows tests it on the top rows (1 to ${MAX_SETUP_TEST_ROWS}); auto-run is turned on only after a `
      + 'run on every row. Returns a setup_run with each step\'s run_id (get_run_status works on those); follow '
      + 'the whole chain with get_setup_run. A setup whose requests read saved keys needs the "secrets" scope.',
    inputSchema: z.object({
      sheet_id: z.string(),
      setup_id: z.string(),
      inputs: names.optional().describe('{ "<setup input>": "<column of this sheet>" }'),
      names: names.optional().describe('{ "<step main column>": "<new name>" }'),
      models: names.optional().describe('{ "<AI step main column>": "<OpenRouter model id>" }'),
      first_rows: z.number().int().min(1).max(MAX_SETUP_TEST_ROWS).optional(),
      estimate_only: lenientBoolean().optional().describe('Default true: price it, start nothing'),
      webhook_id: z.string().optional().describe(
        'A run webhook (list_run_webhooks) to notify when the setup finishes, signed; poll get_setup_run anyway'),
    }).strict(),
  }, async ({ sheet_id, setup_id, ...a }) => {
    const denied = missingScope(ctx, 'run');
    if (denied) return denied;
    const input = applyInputOf(a, 'mcp');
    if ('fail' in input) return err(input.message);
    const out = await applySetup(ctx.userId, sheet_id, setup_id, input, { hasSecretsScope: ctx.scopes.has('secrets') });
    if ('fail' in out) {
      const extra = out.missing ? ` Inputs without a column: ${out.missing.join(', ')}.`
        : out.taken ? ` Names already taken: ${out.taken.join(', ')}.` : '';
      return err(out.message + extra);
    }
    return ok(out.ok);
  });

  registerTool(server, 'get_setup_run', {
    description:
      'Where a setup being used on a sheet is: running, paused, done, failed or cancelled, the layer it\'s on, '
      + 'and each step\'s state, run_id and note (why it failed, or that its auto-run wasn\'t turned on), and the '
      + 'choices it was used with. Pass setup_run_id, or sheet_id for the sheet\'s latest ones (with setup_id, '
      + 'that setup\'s).',
    inputSchema: z.object({ setup_run_id: z.string().optional(), sheet_id: z.string().optional(),
      setup_id: z.string().optional() }).strict(),
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
      + 'further step starts. Cancelling keeps the columns and values made so far.',
    inputSchema: z.object({ setup_run_id: z.string(), action: z.enum(['pause', 'resume', 'cancel']) }).strict(),
  }, async ({ setup_run_id, action }) => {
    const denied = missingScope(ctx, 'run');
    if (denied) return denied;
    const out = await controlSetupRun(ctx.userId, setup_run_id, action, ctx.scopes.has('secrets'));
    return 'ok' in out ? ok(out.ok) : err(out.message);
  });
}
