// A run that parks (lib/run-wait-ring.ts): its rows wait for a run that can't go on in a job slot (queued,
// paused, or parked itself), so instead of holding a slot it gives it back. Its loop starts no more rows and
// lets the ones out finish; the rows it didn't send stay ⏳ for its resume path, nothing sent or billed for them.
// Then it goes back to 'pending' (a compare-and-set on running and its generation, so a pause, cancel or resume
// meanwhile wins) and its job is snoozed: the queue gives the slot to the next job and runs this same job again
// after the delay (src/jobs/*). The generation stays: the snoozed job is pinned to it (queue.ts), and no worker
// of the run is left to write (every row out has settled). The run they wait for, queued behind it, gets the
// slot first: the delay is never under three of the queue's polls, and a queued job is only claimed once its
// time has come. A pending run holds its columns as before, and a pause, cancel or resume works on it as on any
// queued run; boot picks a pending run up again with a new job (lib/orphan-runs.ts), and the snoozed one then
// finds its generation moved and does nothing.
import { db } from './db';
import { RUN_PARK_MS, RUN_PARK_PAUSED_MS, SIDEQUEST_POLL_MS } from './constants';

export type RunParked = { parkMs: number };

export const parkDelay = (why: 'queued' | 'paused'): number =>
  Math.max(why === 'paused' ? RUN_PARK_PAUSED_MS : RUN_PARK_MS, 3 * SIDEQUEST_POLL_MS);

// The run back to pending, or undefined when it isn't ours to park any more.
export function parkRun(table: 'ai_runs' | 'http_runs', runId: string, generation: number, parkMs: number)
  : RunParked | undefined {
  const r = db.prepare(`UPDATE ${table} SET status = 'pending', updated_at = datetime('now')
    WHERE id = ? AND status = 'running' AND worker_generation = ?`).run(runId, generation);
  return r.changes > 0 ? { parkMs } : undefined;
}
