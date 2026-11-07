/* eslint-disable @typescript-eslint/no-require-imports */
// See ai-run-job.ts for the loader rationale.
import type { Job as JobType } from 'sidequest';
const { Job } = require('sidequest') as { Job: typeof JobType };
const { processAIRerun } = require('../services/ai-runner') as
  typeof import('../services/ai-runner');

export class AIRerunJob extends Job {
  // expectedGeneration: see ai-run-job.ts.
  // A parked run's job is snoozed: see ai-run-job.ts.
  async run(runId: string, targetRows: number[], expectedGeneration?: number): Promise<unknown> {
    const parked = await processAIRerun(runId, targetRows, expectedGeneration);
    return parked ? this.snooze(parked.parkMs) : undefined;
  }
}
