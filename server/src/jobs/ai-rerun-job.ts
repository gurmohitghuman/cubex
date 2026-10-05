/* eslint-disable @typescript-eslint/no-require-imports */
// See ai-run-job.ts for the loader rationale.
import type { Job as JobType } from 'sidequest';
const { Job } = require('sidequest') as { Job: typeof JobType };
const { processAIRerun } = require('../services/ai-runner') as
  typeof import('../services/ai-runner');

export class AIRerunJob extends Job {
  // expectedGeneration: see ai-run-job.ts.
  async run(runId: string, targetRows: number[], expectedGeneration?: number): Promise<void> {
    await processAIRerun(runId, targetRows, expectedGeneration);
  }
}
