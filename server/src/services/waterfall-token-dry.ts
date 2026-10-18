// waterfall_column with dry_run (MCP, and POST /api/v1/sheets/:id/waterfall-
// columns): a few rows for real, nothing written to the sheet. It starts the
// dry run (services/waterfall-dry-run.ts), waits up to
// WATERFALL_DRY_WAIT_SECONDS for it to end, and answers with each row's trace
// (or, still running, how to read it).
import { WATERFALL_DRY_WAIT_SECONDS } from '../lib/constants';
import { parseBooleanOption } from '../lib/web-search-options';
import type { WaterfallRunInput } from '../lib/waterfall/input';
import { bad, startWindow, type TokenCaller, type TokenRunResult } from './run-start-token';
import { readRunLedger, runRequestHash, writeRunLedger } from '../lib/run-idempotency';
import { waitForRunChange } from './run-status-wait';
import { startWaterfallDryRun } from './waterfall-dry-run';
import { readDryRun, type DryRunView } from './waterfall-dry-read';

type Json = Record<string, unknown>;
const ENDED = new Set(['completed', 'failed', 'cancelled', 'paused']);

export function dryRunJson(v: DryRunView): Json {
  const ended = ENDED.has(v.run.status) && !v.run.starting;
  return {
    dry_run: true, run_id: v.run.id, status: v.run.status, ...(v.run.message ? { message: v.run.message } : {}),
    column: v.column, ...(v.only ? { test_step: v.only.label } : {}), spent_usd: v.run.spent.total_usd,
    rows: v.rows.map(r => ({
      row_id: r.row_id, inputs: r.inputs, done: r.done, ...(r.gone ? { gone: true } : {}), value: r.value,
      answered_by: r.answered_by,
      cost_usd: r.cost_usd,
      steps: r.steps.map(t => ({
        label: t.label, outcome: t.outcome, ...(t.value ? { value: t.value } : {}),
        ...(t.detail ? { detail: t.detail } : {}), cost_usd: t.cost_usd, ...(t.from ? { from: t.from } : {}),
        ...(t.check ? { check: t.check } : {}),
      })),
    })),
    note: v.run.status === 'paused'
      ? 'It paused (see message): control_run resume or cancel it (run_type "waterfall"). Nothing was written.'
      : ended ? 'Nothing was written to the sheet. For 7 days a real run replays these answers at no cost.'
        : 'Still running: read it with get_run_results (run_type "waterfall", status_filter "all").',
  };
}

export async function tokenDryRun(c: TokenCaller, sheetId: string, input: WaterfallRunInput, a: Json)
  : Promise<TokenRunResult> {
  if (a.estimate_only !== undefined && parseBooleanOption(a.estimate_only) === true) {
    return bad('dry_run runs a few rows for real (at their cost) and writes nothing: leave out estimate_only.');
  }
  for (const k of ['auto_run', 'webhook_id']) {
    if (a[k] !== undefined) return bad(`${k} doesn't go with dry_run.`);
  }
  // A retry with the same idempotency key (REST sends its header as one) reads the first dry run.
  const key = typeof a.idempotency_key === 'string' ? a.idempotency_key : null;
  const { rowGeneration: _gen, ...rest } = input;
  const hash = runRequestHash('waterfall_dry', { sheet_id: sheetId, input: rest });
  const prior = key ? readRunLedger(c.userId, key, hash) : null;
  if (prior && 'conflict' in prior) return bad('Idempotency key was already used with different arguments.');
  let runId: string;
  if (prior) runId = prior.replay.run_id;
  else {
    const limited = startWindow(c);
    if (limited) return limited;
    const out = await startWaterfallDryRun(c.userId, sheetId, input, { hasSecretsScope: c.scopes.has('secrets') });
    if ('fail' in out) return out;
    runId = out.ok.runId;
    if (key) writeRunLedger(c.userId, key, hash, 'waterfall_dry', { run_id: runId });
  }
  const deadline = Date.now() + WATERFALL_DRY_WAIT_SECONDS * 1000;
  for (;;) {
    const asked = Date.now();
    const left = Math.ceil((deadline - asked) / 1000);
    if (left <= 0) break;
    const s = await waitForRunChange('http', runId, c.userId, left);
    if (!s || ENDED.has(s.status)) break;
    // Another wait of this account's holds it: check again in a moment instead.
    if (Date.now() - asked < 500) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const view = readDryRun(c.userId, runId);
  if (!view) return { fail: 'not_found', message: 'The dry run went missing.' };
  return { ok: { ...dryRunJson(view), ...(prior ? { replayed: true } : {}) }, started: !prior };
}
