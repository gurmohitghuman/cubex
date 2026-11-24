import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { SETUP_CALL_KEEP_HOURS, SETUP_CALL_MAX_ITEMS } from '../lib/constants-setups';
import { RUN_SPEND_LIMIT_MAX_USD } from '../lib/constants';
import { CALL_NOT_FOUND, callSetup, getSetupCall } from '../services/setup-call';
import { callInputOf } from '../services/setup-call-input';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';
import { capToolNote } from '../lib/token-spend';

const names = z.record(z.string(), z.string());
const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const WAIT_STEP_MS = 500;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// A saved setup called like a function on items, without a sheet (services/setup-call.ts): call_setup,
// get_setup_call. Pause, resume and stop go through control_setup_run with the call's id.
export function registerSetupCallTools(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'call_setup', {
    description:
      `Run a saved setup (list_setups) on 1-${SETUP_CALL_MAX_ITEMS} items without a sheet, like a function; each `
      + 'item is keyed by the setup\'s inputs. COSTS MONEY as apply_setup does, and takes its estimate_only '
      + '(default true: price it, tell the user, call again with false), max_cost_usd, allow_unpriced and models. '
      + 'Returns a setup_call: get_setup_call gives each item\'s outputs. More items: create_upload_link with '
      + 'setup_id.'
      + capToolNote(ctx.spend ?? null, true),
    inputSchema: z.object({
      setup_id: z.string().describe('The setup (list_setups)'),
      items: z.array(z.record(z.string(), cell)).min(1).max(SETUP_CALL_MAX_ITEMS)
        .describe('[{ "<setup input>": value }]; an input left out reads as empty'),
      models: names.optional().describe('{ "<AI step main column>": "<OpenRouter model id>" }'),
      estimate_only: lenientBoolean().optional().describe('Default true: price it, start nothing'),
      webhook_id: z.string().optional().describe('A run webhook to notify when the call finishes'),
      max_cost_usd: z.number().positive().max(RUN_SPEND_LIMIT_MAX_USD).optional()
        .describe('Refuse to start when the estimate could cost more, in dollars'),
      allow_unpriced: lenientBoolean().optional().describe('With max_cost_usd: start a step with no known price'),
    }).strict(),
  }, async ({ setup_id, items, ...a }) => {
    const denied = missingScope(ctx, 'run');
    if (denied) return denied;
    const input = callInputOf(a, 'mcp');
    if ('fail' in input) return err(input.message);
    const out = await callSetup(ctx.userId, setup_id, items, input, { hasSecretsScope: ctx.scopes.has('secrets') });
    if ('fail' in out) return err(out.message + (out.estimate ? ` Estimate: ${JSON.stringify(out.estimate)}` : ''));
    return ok(out.ok);
  });

  registerTool(server, 'get_setup_call', {
    description:
      'A setup call (call_setup): its status and steps, and once finished, results: each item\'s outputs by '
      + `column, ${SETUP_CALL_MAX_ITEMS} at a time (next_from starts the next page). wait_seconds waits for it to `
      + `finish. Kept ${SETUP_CALL_KEEP_HOURS} hours after it finishes. Read-only.`,
    inputSchema: z.object({
      setup_call_id: z.string().describe('The call (call_setup returned it)'),
      wait_seconds: z.number().int().min(0).max(25).optional()
        .describe('Wait up to this many seconds for it to finish'),
      results_from: z.number().int().min(0).optional().describe('First item of the page (next_from)'),
      limit: z.number().int().min(1).max(SETUP_CALL_MAX_ITEMS).optional()
        .describe(`Items in the page (default ${SETUP_CALL_MAX_ITEMS})`),
    }).strict(),
  }, async ({ setup_call_id, wait_seconds, results_from, limit }) => {
    const denied = missingScope(ctx, 'read');
    if (denied) return denied;
    const page = { from: results_from, limit };
    let call = getSetupCall(ctx.userId, setup_call_id, page);
    const until = Date.now() + (wait_seconds ?? 0) * 1000;
    const was = call?.status;
    // Until it finishes, pauses or resumes, or the time is up.
    while (call && call.status === was && !call.results && Date.now() < until) {
      await sleep(Math.min(WAIT_STEP_MS, until - Date.now()));
      call = getSetupCall(ctx.userId, setup_call_id, page);
    }
    return call ? ok(call) : err(CALL_NOT_FOUND);
  });
}
