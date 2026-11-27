// get_run's status (tools-get-run.ts): the same summary as GET /v1/{ai,http}-runs/:id, needs only 'read'.
// Optionally waits up to 25 seconds for the status to change (progress alone doesn't end the wait), so an agent
// polls less often; with the account's wait slots all taken it answers at once, with waited: false and
// retry_after_seconds. control_run is in tools-run-manage.ts.
import { getAiRunSummary, getHttpRunSummary } from '../services/run-status';
import { waitForRunChange } from '../services/run-status-wait';
import { McpAuthCtx, ok, err, type ErrResult, type OkResult } from './tool-helpers';
import type { ToolAnswer } from './tool-outputs';
import { kindOf } from './run-kind';

export interface RunStatusAsk { run_type: 'ai' | 'http' | 'enrichment' | 'waterfall'; run_id: string;
  wait_seconds?: number }

export async function runStatusAnswer(ctx: McpAuthCtx, a: RunStatusAsk):
  Promise<OkResult<ToolAnswer<'get_run'>> | ErrResult> {
  const kind = kindOf(a.run_type, a.run_id, ctx.userId);
  if (!kind) return err('Enrichment run not found');
  const { run, noSlot } = (a.wait_seconds ?? 0) > 0
    ? await waitForRunChange(kind, a.run_id, ctx.userId, a.wait_seconds!, ctx.abortSignal, { statusOnly: true })
    : { run: kind === 'ai' ? getAiRunSummary(a.run_id, ctx.userId) : getHttpRunSummary(a.run_id, ctx.userId) };
  if (!run) return err('Run not found');
  return ok(noSlot ? { ...run, waited: false, retry_after_seconds: noSlot.retryAfterSec } : run);
}
