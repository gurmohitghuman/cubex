/* eslint-disable @typescript-eslint/no-require-imports */
// This file is loaded by Sidequest in a worker thread via the manual-loader
// (sidequest.jobs.cjs at repo root). The shim requires this module from
// server/dist/jobs/ — i.e., always the COMPILED CJS output, never the .ts
// source. server/src/package.json sets {"type":"commonjs"} so the compiled
// output is plain CJS regardless of the root "type":"module" setting.
import type { Job as JobType } from 'sidequest';
const { Job } = require('sidequest') as { Job: typeof JobType };
const { processAIRun } = require('../services/ai-runner') as
  typeof import('../services/ai-runner');

export class AIRunJob extends Job {
  // expectedGeneration is stamped at enqueue (see queue.ts) so a stale queued
  // job — superseded by a pause/resume that bumped the generation — rejects
  // itself at startup. Optional: jobs enqueued before this arg existed carry
  // undefined and skip the check.
  async run(runId: string, expectedGeneration?: number): Promise<void> {
    await processAIRun(runId, expectedGeneration);
  }
}
