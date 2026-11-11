// Resuming a plain HTTP API run from MCP control_run or POST /api/v1/http-runs/:id/resume, optionally with
// another concurrency: requests at once, the run's config batchSize. The update that resumes the run writes it
// (run-lifecycle.ts), as it does an AI run's new spend limit: a resume a check refuses leaves the run as it was,
// and a later rerun, which repeats the run's config, keeps it. Enrichment and waterfall runs resume through their
// own services.
import { httpConcurrencyProblem } from '../lib/run-concurrency';
import { resumeRun, type ControlOutcome } from './run-lifecycle';

export async function resumeHttpRun(
  runId: string, userId: string, hasSecretsScope: boolean, concurrency: unknown,
): Promise<ControlOutcome> {
  const problem = httpConcurrencyProblem(concurrency);
  if (problem) return { fail: 'bad_request', message: problem };
  return resumeRun('http', runId, userId, hasSecretsScope, null, (concurrency as number | undefined) ?? null);
}
