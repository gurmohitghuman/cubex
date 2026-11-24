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
      `Run a saved setup (list_setups) on 1-${SETUP_CALL_MAX_ITEMS} items without a sheet, like a function: each `
      + 'item is an object keyed by the setup\'s input names, and the answer gives each item\'s outputs by the '
      + 'columns the setup makes. Use it to enrich a few records for a script or another app; to fill a sheet '
      + 'use apply_setup. COSTS MONEY as apply_setup does: AI steps call your model per item, enrichments spend '
      + 'your treg balance, HTTP API steps send a request per item; clean and formula steps are free. '
      + 'ESTIMATE_ONLY DEFAULTS TO TRUE: the first call prices it and starts nothing; tell the user, then call '
      + 'again with estimate_only:false. max_cost_usd refuses to start when the estimate could pass it (and a step '
      + 'with no known price, unless allow_unpriced). A setup whose requests read saved keys needs the "secrets" '
      + 'scope. Returns a setup_call with its id; poll get_setup_call (wait_seconds) for the results, or pass '
      + `webhook_id to be told when it finishes. Results are kept ${SETUP_CALL_KEEP_HOURS} hours after it finishes. `
      + 'control_setup_run pauses, resumes or cancels it by that id.'
      + capToolNote(ctx.spend ?? null, true),
    inputSchema: z.object({
      setup_id: z.string().describe('The setup (list_setups)'),
      items: z.array(z.record(z.string(), cell)).min(1).max(SETUP_CALL_MAX_ITEMS)
        .describe('[{ "<setup input>": value }]: one object per item; an input left out reads as empty'),
      models: names.optional().describe('{ "<AI step main column>": "<OpenRouter model id>" }'),
      estimate_only: lenientBoolean().optional().describe('Default true: price it, start nothing'),
      webhook_id: z.string().optional().describe(
        'A run webhook (list_run_webhooks) to notify when the call finishes (kind setup, run_id = the call id)'),
      max_cost_usd: z.number().positive().max(RUN_SPEND_LIMIT_MAX_USD).optional()
        .describe('Refuse to start when the estimate could cost more than this many dollars in all'),
      allow_unpriced: lenientBoolean().optional()
        .describe('With max_cost_usd: start even when a step has no known price (default false)'),
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
      'Where a setup call (call_setup) is: running, paused, done, failed or cancelled, each step\'s state and '
      + 'run_id, and once it has finished, results: each item, in the order sent, with its outputs by column '
      + '(null when empty). With wait_seconds it answers when the call finishes or the time is up, so you poll '
      + `less. Results are kept ${SETUP_CALL_KEEP_HOURS} hours after the call finishes (keep_until). Read-only.`,
    inputSchema: z.object({
      setup_call_id: z.string().describe('The call (call_setup returned it)'),
      wait_seconds: z.number().int().min(0).max(25).optional()
        .describe('Wait up to this many seconds for the call to finish (0-25)'),
    }).strict(),
  }, async ({ setup_call_id, wait_seconds }) => {
    const denied = missingScope(ctx, 'read');
    if (denied) return denied;
    let call = getSetupCall(ctx.userId, setup_call_id);
    const until = Date.now() + (wait_seconds ?? 0) * 1000;
    const was = call?.status;
    // Until it finishes, pauses or resumes, or the time is up.
    while (call && call.status === was && !call.results && Date.now() < until) {
      await sleep(Math.min(WAIT_STEP_MS, until - Date.now()));
      call = getSetupCall(ctx.userId, setup_call_id);
    }
    return call ? ok(call) : err(CALL_NOT_FOUND);
  });
}
