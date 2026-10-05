/* eslint-disable @typescript-eslint/no-require-imports */
import fs from 'node:fs';
import path from 'node:path';
import { Sidequest } from 'sidequest';
// Job classes are loaded from the COMPILED dist output via the manual loader
// shim (sidequest.jobs.cjs at repo root). Here in the API process we just need
// references to the same classes for `Sidequest.build()` to bind to. We also
// require from dist so the class identity matches what worker threads load.
import type { JobClassType } from 'sidequest';
import { WORKER_POOL_SIZE } from './lib/constants';
import { db } from './lib/db';
import { DATA_DIR } from './lib/db-path';
import { parseTargetRows } from './lib/run-targets';
import type { RecoveredRuns } from './lib/orphan-runs';

const REPO_ROOT = path.resolve(__dirname, '../..');
const JOBS_SHIM_PATH = path.resolve(REPO_ROOT, 'sidequest.jobs.cjs');
const COMPILED_JOBS_DIR = path.resolve(__dirname, './jobs');

const { AIRunJob } = require(path.join(COMPILED_JOBS_DIR, 'ai-run-job')) as {
  AIRunJob: JobClassType;
};
const { AIRerunJob } = require(path.join(COMPILED_JOBS_DIR, 'ai-rerun-job')) as {
  AIRerunJob: JobClassType;
};
const { HTTPRunJob } = require(path.join(COMPILED_JOBS_DIR, 'http-run-job')) as {
  HTTPRunJob: JobClassType;
};
const { HTTPRerunJob } = require(path.join(COMPILED_JOBS_DIR, 'http-rerun-job')) as {
  HTTPRerunJob: JobClassType;
};

// Sidequest is configured to point at server/data/jobs.db — a separate file
// from cubex.db so:
//   1. Heavy job-table writes (claimed/started/completed transitions) don't
//      contend with cubex.db's WAL.
//   2. cubex.db can be VACUUMed / backed up / restored independently of the
//      job state.
//   3. If we ever drop the queue (e.g. swap to Redis-backed BullMQ), no
//      data migration is needed.
//
// In-process mode: Sidequest spawns worker threads inside this same Node
// process. Worker threads have their own JS context — they can't see the
// API process's request handlers, in-memory caches, or SSE clients. That's
// why ai-runner / http-runner write everything observable to the DB.
//
// Manual job resolution: worker threads load job code via `await import()`,
// which (a) doesn't inherit tsx's TS hook and (b) chokes on ESM `import`
// syntax under root "type":"module". We sidestep both by pointing
// Sidequest at a `.cjs` shim file (Node always treats `.cjs` as CJS) that
// re-exports the compiled job classes from server/dist/jobs/. That means
// the dev loop must run `tsc -p server/tsconfig.json --watch` alongside the
// API so dist stays fresh.
//
// Concurrency: Sidequest's maxConcurrentJobs governs how many JOBS run in
// parallel; each job (AI run / HTTP run) then has its OWN per-row
// concurrency configured in ai_runs.concurrency / batchSize.
// We start at 4 concurrent jobs — enough to handle a few users running
// simultaneously without saturating CPU on a small server.

// Next to cubex.db by default, so one data directory holds everything that
// must persist (queued/resumable runs included).
export const JOBS_DB_PATH = process.env.JOBS_DB_PATH || path.join(DATA_DIR, 'jobs.db');

let started = false;

export async function startQueue(): Promise<void> {
  if (started) return;
  started = true;

  await Sidequest.start({
    backend: {
      driver: '@sidequest/sqlite-backend',
      config: JOBS_DB_PATH,
    },
    maxConcurrentJobs: WORKER_POOL_SIZE,
    manualJobResolution: true,
    jobsFilePath: JOBS_SHIM_PATH,
    // Don't start the bundled web dashboard: it would bind port 8678 with no
    // auth and expose job internals.
    dashboard: { enabled: false },
  });

  console.log(`🧰 Sidequest started (jobs.db: ${JOBS_DB_PATH}, shim: ${JOBS_SHIM_PATH})`);

  // Tighten perms on jobs.db and its WAL/SHM siblings after Sidequest has
  // created them. process.umask(0o077) in index.ts handles future-created
  // files, but Sidequest may have created jobs.db before that (depending on
  // boot order). Belt-and-suspenders: chmod every existing sibling now.
  for (const ext of ['', '-wal', '-shm', '-journal']) {
    const p = `${JOBS_DB_PATH}${ext}`;
    try {
      if (fs.existsSync(p)) fs.chmodSync(p, 0o600);
    } catch (err) {
      console.warn(`⚠️  Could not chmod ${p} to 0o600:`, (err as Error).message);
    }
  }
}

export async function stopQueue(): Promise<void> {
  if (!started) return;
  started = false;
  try {
    await Sidequest.stop();
  } catch (err) {
    console.error('Error stopping Sidequest:', err);
  }
}

// Enqueue helpers used by routes. Thin wrappers so the routes don't need to
// import Sidequest + the Job class directly — and so future swaps (different
// queue backend, different routing) only touch this file.

// Stamp the run's CURRENT worker_generation into the job args; the worker
// rejects on mismatch at startup. This kills the stale-QUEUED-job race:
// pause a run while its job is still waiting for a pool slot, resume (gen
// bump + new job) — and BOTH jobs eventually start. The in-run generation
// guard can't catch it (each job reads the current post-bump generation at
// startup, so both match); pinning each job to the generation it was created
// for makes the old one reject itself. -1 = run vanished → worker rejects.
function currentGeneration(table: 'ai_runs' | 'http_runs', runId: string): number {
  const row = db.prepare(`SELECT worker_generation FROM ${table} WHERE id = ?`)
    .get(runId) as { worker_generation: number } | undefined;
  return row?.worker_generation ?? -1;
}

export async function enqueueAIRun(runId: string): Promise<void> {
  await Sidequest.build(AIRunJob).enqueue(runId, currentGeneration('ai_runs', runId));
}

export async function enqueueAIRerun(runId: string, targetRows: number[]): Promise<void> {
  await Sidequest.build(AIRerunJob).enqueue(runId, targetRows, currentGeneration('ai_runs', runId));
}

export async function enqueueHTTPRun(runId: string): Promise<void> {
  await Sidequest.build(HTTPRunJob).enqueue(runId, currentGeneration('http_runs', runId));
}

export async function enqueueHTTPRerun(runId: string, targetRows: number[]): Promise<void> {
  await Sidequest.build(HTTPRerunJob).enqueue(runId, targetRows, currentGeneration('http_runs', runId));
}

// Re-enqueue the runs that resetOrphanedRuns() recovered (flipped 'running'/
// 'pending' → 'pending' on boot). MUST be called AFTER startQueue() — Sidequest
// must be up to accept jobs. Mirrors the manual resume handlers: re-dispatch a
// rerun via its stored target_rows (else enqueueAIRun would overwrite the whole
// column with the rerun's prompt), else a full run. Each run is enqueued
// independently — one failure rolls THAT run to 'failed' (so it doesn't sit
// 'pending' forever, invisible to the worker) without blocking the others.
export async function resumeRecoveredRuns(recovered: RecoveredRuns): Promise<void> {
  for (const id of recovered.aiRunIds) {
    try {
      const row = db.prepare('SELECT target_rows FROM ai_runs WHERE id = ?')
        .get(id) as { target_rows: string | null } | undefined;
      const targets = parseTargetRows(row?.target_rows ?? null);
      if (targets) await enqueueAIRerun(id, targets);
      else await enqueueAIRun(id);
    } catch (err) {
      console.error(`Failed to resume AI run ${id} on boot:`, err);
      db.prepare(
        "UPDATE ai_runs SET status='failed', error_message='Could not resume after restart. Re-run to continue.', updated_at=datetime('now') WHERE id=? AND status='pending'",
      ).run(id);
    }
  }
  for (const id of recovered.httpRunIds) {
    try {
      const row = db.prepare('SELECT target_rows FROM http_runs WHERE id = ?')
        .get(id) as { target_rows: string | null } | undefined;
      const targets = parseTargetRows(row?.target_rows ?? null);
      if (targets) await enqueueHTTPRerun(id, targets);
      else await enqueueHTTPRun(id);
    } catch (err) {
      console.error(`Failed to resume HTTP run ${id} on boot:`, err);
      db.prepare(
        "UPDATE http_runs SET status='failed', error_message='Could not resume after restart. Re-run to continue.', updated_at=datetime('now') WHERE id=? AND status='pending'",
      ).run(id);
    }
  }
}
