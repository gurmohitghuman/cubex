// An AI run's hard spend limit, from the API side: what the app's dialog
// shows and suggests, and resuming with a new limit (MCP control_run, REST
// and the app's resume), as an enrichment run's resume raises its run limit
// (services/enrich-run-status.ts). The worker keeps the limit
// (services/ai-spend-gate.ts); the limit lives on the run
// (ai_runs.spend_limit_usd, migration 051), so a restart's resume keeps it,
// and so do what its cut-off calls hold and its next row's most (052). The
// least limit it can go on with: services/ai-run-floor.ts.
import { micro, money, moneyUp, usdLimitOf, usdUp } from '../lib/cost-ceiling';
import { RUN_SPEND_LIMIT_MAX_USD } from '../lib/constants';
import { resumeRun, type ControlOutcome } from './run-lifecycle';
import { floorOf, limitRow, type Floor, type LimitRow } from './ai-run-floor';

export type AiResumeOutcome = ControlOutcome | { fail: 'bad_request'; message: string };

// What the app's "Raise the spend limit" dialog reads (GET /api/ai/runs/:id/spend-limit): one run row and
// its usage record, never its results. suggest_usd, the amount filled in: the cheapest that can work, the
// least plus each row left at what a row has cost so far on average (avg_row_usd: what it spent over the
// rows it processed; none before a row has), rounded up as moneyUp prints it. An AI row's most is a worst
// case, often many times what rows really cost, so finish_usd (enough to finish for sure: what it spent and
// holds, plus each row left at the next row's most) is shown as words, never filled in.
export interface AiLimitView {
  column_name: string | null; status: string; pause_reason: string | null; message: string | null;
  limit_usd: number | null; spent_usd: number; cut_off_usd: number; next_row_usd: number | null;
  least_usd: number; suggest_usd: number; avg_row_usd: number | null; finish_usd: number | null;
  rows_left: number;
}
const capped = (usd: number) => Math.min(usdUp(usd), RUN_SPEND_LIMIT_MAX_USD);
export function aiLimitView(runId: string, userId: string): AiLimitView | null {
  const r = limitRow(runId, userId);
  if (!r) return null;
  const f = floorOf(runId, userId, r);
  const rowsLeft = Math.max(0, r.total_rows - r.processed_rows);
  const avg = r.processed_rows > 0 ? f.spent / r.processed_rows : null;
  const suggest = Math.max(f.least, f.least + rowsLeft * (avg ?? 0));
  const finish = f.nextRow ? Math.max(f.least, f.spent + f.cutOff + Math.max(1, rowsLeft) * f.nextRow) : null;
  return {
    column_name: r.column_name, status: r.status, pause_reason: r.pause_reason, message: r.error_message,
    limit_usd: r.spend_limit_usd, spent_usd: f.spent / 1e6, cut_off_usd: f.cutOff / 1e6,
    next_row_usd: f.nextRow === null ? null : f.nextRow / 1e6, least_usd: f.least / 1e6,
    suggest_usd: capped(suggest / 1e6), avg_row_usd: avg === null ? null : avg / 1e6,
    finish_usd: finish === null ? null : capped(finish / 1e6), rows_left: rowsLeft,
  };
}

// Why a resume with spend limit `next` would only pause again, or null.
function shortOf(f: Floor, r: LimitRow, next: number, field: string): string | null {
  if (micro(next) >= f.least) return null;
  const cut = f.cutOff > 0 ? `, calls cut off before they answered may still be billed up to `
    + `${money(f.cutOff / 1e6)} (that counts as spent)` : '';
  const row = f.nextRow ? ` and its next row could cost up to ${money(f.nextRow / 1e6)}` : '';
  const lead = r.pause_reason === 'spend_limit' && r.spend_limit_usd !== null
    ? `The run paused at its ${money(r.spend_limit_usd)} spend limit: it spent ${money(f.spent / 1e6)}${cut}${row}.`
    : `The run spent ${money(f.spent / 1e6)} of its ${money(next)} spend limit${cut}.`;
  return `${lead} Resume it with a higher ${field}, at least ${moneyUp(f.least / 1e6)}, to go on.`;
}

// Resumes a paused AI run, setting its spend limit to `limitRaw` when one is
// given (field: the name the caller sent it under) in the update that resumes
// it. Refused with what to do, and nothing changed, when the limit it would
// have is under the least it can go on with (floorOf): it would pause again at
// once. Any other refusal (a token's cap, a model gone) leaves the old limit too.
export async function resumeAiRun(
  runId: string, userId: string, limitRaw: unknown, hasSecretsScope: boolean, field = 'spend_limit_usd',
): Promise<AiResumeOutcome> {
  const limit = usdLimitOf(limitRaw, field);
  if ('error' in limit) return { fail: 'bad_request', message: limit.error };
  const run = limitRow(runId, userId);
  if (!run) return { fail: 'not_found', message: 'Run not found' };
  if (run.status !== 'paused') return { fail: 'not_paused', message: `Run is not paused (status: ${run.status})` };
  const next = limit.value ?? run.spend_limit_usd;
  const short = next === null ? null : shortOf(floorOf(runId, userId, run), run, next, field);
  if (short) return { fail: 'bad_request', message: short };
  return resumeRun('ai', runId, userId, hasSecretsScope, limit.value);
}

// A setup can't give its step's AI run a higher limit (setup-run-control.ts):
// why resuming the setup would leave this run where it is, or null.
export function setupResumeLimitRefusal(runId: string, userId: string): string | null {
  const r = limitRow(runId, userId);
  if (!r || r.status !== 'paused' || r.pause_reason !== 'spend_limit' || r.spend_limit_usd === null) return null;
  return `"${r.column_name ?? 'Its AI step'}" paused at its ${money(r.spend_limit_usd)} spend limit, and resuming `
    + "the setup can't raise it. Stop the setup and apply it again with a higher max_cost_usd: that carries on "
    + 'where this one stopped.';
}
