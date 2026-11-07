/* eslint-disable @typescript-eslint/no-require-imports */
// See ai-run-job.ts for the loader rationale.
import type { Job as JobType } from 'sidequest';
const { Job } = require('sidequest') as { Job: typeof JobType };
const { processHTTPRun } = require('../services/http-runner') as
  typeof import('../services/http-runner');

export class HTTPRunJob extends Job {
  // expectedGeneration: see ai-run-job.ts.
  // A parked run's job is snoozed: see ai-run-job.ts.
  async run(runId: string, expectedGeneration?: number): Promise<unknown> {
    const parked = await processHTTPRun(runId, expectedGeneration);
    return parked ? this.snooze(parked.parkMs) : undefined;
  }
}
