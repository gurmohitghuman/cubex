/* eslint-disable @typescript-eslint/no-require-imports */
// See ai-run-job.ts for the loader rationale. Mirrors ai-rerun-job: a dedicated
// job class for HTTP reruns keeps the (runId, targetRows, expectedGeneration)
// arg order identical to the AI rerun and leaves the first-run HTTPRunJob
// signature untouched.
import type { Job as JobType } from 'sidequest';
const { Job } = require('sidequest') as { Job: typeof JobType };
const { processHTTPRun } = require('../services/http-runner') as
  typeof import('../services/http-runner');

export class HTTPRerunJob extends Job {
  // expectedGeneration: see ai-run-job.ts. targetRows: the row_index subset this
  // rerun should process (passed through to the runner so resume stays scoped).
  async run(runId: string, targetRows: number[], expectedGeneration?: number): Promise<void> {
    await processHTTPRun(runId, expectedGeneration, targetRows);
  }
}
