import { z } from 'zod';
import { SETUP_CALL_KEEP_HOURS, SETUP_CALL_MAX_ITEMS } from '../lib/constants-setups';
import { callSetup, getSetupCall } from '../services/setup-call';
import { callInputOf } from '../services/setup-call-input';
import { getSetupRun } from '../services/setup-run-store';
import { McpAuthCtx, ok, err } from './tool-helpers';

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const WAIT_STEP_MS = 500;
const FINISHED = new Set(['done', 'failed', 'cancelled']);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// apply_setup's items (and REST POST /setups/:id/calls): objects keyed by the setup's input names.
export const SETUP_ITEMS = z.array(z.record(z.string(), cell)).min(1).max(SETUP_CALL_MAX_ITEMS)
  .describe('[{ "<setup input>": value }]; an input left out reads as empty');

// The apply_setup arguments that only a sheet takes: an item names the setup's inputs itself.
const SHEET_ONLY = ['inputs', 'names', 'first_rows'] as const;

// apply_setup with items: a saved setup called like a function on items, without a sheet (services/setup-call.ts).
// Pause, resume and stop go through control_setup_run with the call's id; get_run (action setup) answers it.
export async function applySetupOnItems(
  ctx: McpAuthCtx, setupId: string, items: unknown, a: Record<string, unknown>,
) {
  const sheetOnly = SHEET_ONLY.filter(k => a[k] !== undefined);
  if (sheetOnly.length) {
    return err(`${sheetOnly.join(', ')} go with sheet_id, not items: each item names the setup's inputs itself.`);
  }
  const input = callInputOf(a, 'mcp');
  if ('fail' in input) return err(input.message);
  const out = await callSetup(ctx.userId, setupId, items, input,
    { hasSecretsScope: ctx.scopes.has('secrets'), tokenId: ctx.tokenId });
  if ('fail' in out) return err(out.message + (out.estimate ? ` Estimate: ${JSON.stringify(out.estimate)}` : ''));
  // A call runs on its own hidden working table, never a sheet the user has.
  return ok({ ...out.ok, changed: [] });
}

export interface RunPage { from?: number; limit?: number }

// One setup run, or a call on items (whose id is a setup run's) with a page of its items' results. With
// wait_seconds it answers when the run finishes, pauses or resumes, or the time is up.
export async function setupRunAnswer(ctx: McpAuthCtx, id: string, waitSeconds: number | undefined, page: RunPage) {
  const read = () => getSetupCall(ctx.userId, id, page) ?? getSetupRun(ctx.userId, id);
  let run = read();
  const until = Date.now() + (waitSeconds ?? 0) * 1000;
  const was = run?.status;
  while (run && run.status === was && !FINISHED.has(run.status) && Date.now() < until) {
    await sleep(Math.min(WAIT_STEP_MS, until - Date.now()));
    run = read();
  }
  if (run) return ok(run);
  return err(`Setup run not found. A call on items is kept ${SETUP_CALL_KEEP_HOURS} hours after it finishes.`);
}
