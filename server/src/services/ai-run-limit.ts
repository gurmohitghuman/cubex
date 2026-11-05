// An AI run's hard spend limit, from the API side: resuming a paused run with
// a new limit (MCP control_run, REST and the app's resume), as an enrichment
// run's resume raises its run limit (services/enrich-run-status.ts). The worker
// keeps the limit (services/ai-spend-gate.ts); the limit lives on the run
// (ai_runs.spend_limit_usd, migration 051), so a restart's resume keeps it.
import { db } from '../lib/db';
import { micro, money, usdLimitOf } from '../lib/cost-ceiling';
import { resumeRun, type ControlOutcome } from './run-lifecycle';
import { runSpentUsd } from './ai-spend-gate';

export type AiResumeOutcome = ControlOutcome | { fail: 'bad_request'; message: string };

// Resumes a paused AI run, setting its spend limit to `limitRaw` when one is
// given (field: the name the caller sent it under) in the update that resumes
// it. Refused with what to do, and nothing changed, instead of pausing at once
// again: a run its limit leaves no room in (it spent it all), and a run that
// paused at its limit (pause_reason spend_limit: the next row's most didn't
// fit, or a cut-off call's may be billed, and spending only grows) unless the
// limit is raised. Any other refusal (a token's cap, a model gone) leaves the
// old limit too.
export async function resumeAiRun(
  runId: string, userId: string, limitRaw: unknown, hasSecretsScope: boolean, field = 'spend_limit_usd',
): Promise<AiResumeOutcome> {
  const limit = usdLimitOf(limitRaw, field);
  if ('error' in limit) return { fail: 'bad_request', message: limit.error };
  const run = db.prepare('SELECT status, spend_limit_usd, pause_reason FROM ai_runs WHERE id = ? AND user_id = ?')
    .get(runId, userId) as { status: string; spend_limit_usd: number | null; pause_reason: string | null } | undefined;
  if (!run) return { fail: 'not_found', message: 'Run not found' };
  if (run.status !== 'paused') return { fail: 'not_paused', message: `Run is not paused (status: ${run.status})` };
  const next = limit.value ?? run.spend_limit_usd;
  if (next !== null) {
    const spent = runSpentUsd(runId, userId);
    const atLimit = run.pause_reason === 'spend_limit' && run.spend_limit_usd !== null
      && micro(next) <= micro(run.spend_limit_usd);
    if (spent + 1e-9 >= next || atLimit) {
      return { fail: 'bad_request', message: `The run spent ${money(spent)} of its ${money(next)} spend limit. `
        + `Resume it with a higher ${field} to go on.` };
    }
  }
  return resumeRun('ai', runId, userId, hasSecretsScope, limit.value);
}
