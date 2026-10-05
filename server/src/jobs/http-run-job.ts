/* eslint-disable @typescript-eslint/no-require-imports */
// See ai-run-job.ts for the loader rationale.
import type { Job as JobType } from 'sidequest';
const { Job } = require('sidequest') as { Job: typeof JobType };
const { processHTTPRun } = require('../services/http-runner') as
  typeof import('../services/http-runner');

export class HTTPRunJob extends Job {
  // expectedGeneration: see ai-run-job.ts.
  async run(runId: string, expectedGeneration?: number): Promise<void> {
    await processHTTPRun(runId, expectedGeneration);
  }
}
