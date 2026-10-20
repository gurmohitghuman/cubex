// Runs whose worker stopped. A running AI or HTTP API run beats updated_at
// while its loop waits on rows, and every finished row moves it too
// (lib/run-pool.ts); one that hasn't moved for RUN_STALL_MS lost its worker
// (a worker thread that died, a wait nothing ends). It is queued again the way
// a resume does it: the generation moves, so the old worker writes nothing if
// it ever wakes, and the new one goes on from the rows still ⏳. Boot does the
// same for every running run (lib/orphan-runs.ts); this sweep covers a server
// that stays up. Enrichment and waterfall runs keep their own loops and are
// left to boot.
//
// A process that was asleep (a laptop lid) skips the sweep it wakes into:
// every run's beat is just as late, and the workers wake with it. A run queued
// again RUN_STALL_REQUEUE_MAX times in this process is paused for a person
// ('stalled'), and none is queued while the data folder is short of space (a
// run there stopped because nothing could be saved).
import { db } from '../lib/db';
import { RUN_STALL_MS, RUN_STALL_REQUEUE_MAX, RUN_STALL_SWEEP_MS } from '../lib/constants';
import { parseTargetRows } from '../lib/run-targets';
import { diskLow } from '../lib/disk-space';
import { enqueueAIRun, enqueueAIRerun, enqueueHTTPRun, enqueueHTTPRerun } from '../queue';

type Kind = 'ai' | 'http';
const TABLE: Record<Kind, 'ai_runs' | 'http_runs'> = { ai: 'ai_runs', http: 'http_runs' };

const STALLED_MESSAGE = 'It stopped making progress and was started again several times. Resume it to try once more.';

interface Stalled { id: string; worker_generation: number; target_rows: string | null }
export type Enqueue = (kind: Kind, id: string, targets: number[] | null) => Promise<void>;

const enqueueRun: Enqueue = (kind, id, targets) => (kind === 'ai'
  ? (targets ? enqueueAIRerun(id, targets) : enqueueAIRun(id))
  : (targets ? enqueueHTTPRerun(id, targets) : enqueueHTTPRun(id)));

const requeued = new Map<string, number>();
let lastSweep = 0;

export async function requeueStalledRuns(now = Date.now(), enqueue: Enqueue = enqueueRun): Promise<void> {
  const gap = lastSweep === 0 ? 0 : now - lastSweep;
  lastSweep = now;
  if (gap > 2 * RUN_STALL_SWEEP_MS || diskLow()) return;
  const age = `-${Math.round(RUN_STALL_MS / 1000)} seconds`;
  for (const kind of ['ai', 'http'] as const) {
    for (const run of stalledRuns(kind, age)) {
      try { await requeue(kind, run, age, enqueue); }
      catch (error) { console.error(`Starting stalled ${kind} run ${run.id} again failed:`, error); }
    }
  }
}

// HTTP: plain HTTP API runs only (an enrichment or a waterfall config carries its block).
function stalledRuns(kind: Kind, age: string): Stalled[] {
  if (kind === 'ai') {
    return db.prepare(`SELECT id, worker_generation, target_rows FROM ai_runs
      WHERE status = 'running' AND placeholder_work IS NULL AND updated_at < datetime('now', ?)`).all(age) as Stalled[];
  }
  return db.prepare(`SELECT id, worker_generation, target_rows FROM http_runs
    WHERE status = 'running' AND placeholder_work IS NULL AND updated_at < datetime('now', ?)
      AND json_extract(config, '$.enrichment') IS NULL AND json_extract(config, '$.waterfall') IS NULL`)
    .all(age) as Stalled[];
}

async function requeue(kind: Kind, run: Stalled, age: string, enqueue: Enqueue): Promise<void> {
  const table = TABLE[kind];
  const times = (requeued.get(run.id) ?? 0) + 1;
  if (times > RUN_STALL_REQUEUE_MAX) {
    pauseStalled(table, run.id, run.worker_generation, age);
    requeued.delete(run.id);
    return;
  }
  // CAS on the generation and the stale beat: a worker that beat meanwhile keeps its run.
  const moved = db.prepare(`UPDATE ${table} SET status = 'pending', worker_generation = worker_generation + 1,
      updated_at = datetime('now')
    WHERE id = ? AND status = 'running' AND worker_generation = ? AND updated_at < datetime('now', ?)`)
    .run(run.id, run.worker_generation, age);
  if (moved.changes === 0) return;
  requeued.set(run.id, times);
  console.warn(`${kind.toUpperCase()} run ${run.id} stopped making progress: queued again (${times}).`);
  try {
    await enqueue(kind, run.id, parseTargetRows(run.target_rows));
  } catch (error) {
    // No job: paused, so it doesn't sit pending with nothing to pick it up.
    pauseStalled(table, run.id, run.worker_generation + 1, null);
    throw error;
  }
}

// Running: only while its beat is still `age` old (a worker that beat meanwhile
// keeps its run). Pending: the one this sweep just queued, whose job failed to start.
function pauseStalled(table: 'ai_runs' | 'http_runs', id: string, generation: number, age: string | null): void {
  if (age !== null) {
    db.prepare(`UPDATE ${table} SET status = 'paused', pause_reason = 'stalled', error_message = ?,
        updated_at = datetime('now')
      WHERE id = ? AND status = 'running' AND worker_generation = ? AND updated_at < datetime('now', ?)`)
      .run(STALLED_MESSAGE, id, generation, age);
  } else {
    db.prepare(`UPDATE ${table} SET status = 'paused', pause_reason = 'stalled', error_message = ?,
        updated_at = datetime('now') WHERE id = ? AND status = 'pending' AND worker_generation = ?`)
      .run(STALLED_MESSAGE, id, generation);
  }
}
