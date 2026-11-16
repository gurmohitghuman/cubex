// Settings' "Prune details older than 90 days": the raw part of every answer
// from enrichment runs that ended before the cutoff (answer-prune.ts says what
// a prune keeps). One job per account at a time, recorded in
// answer_prune_jobs (migration 018) with where it got to, so a restart
// finishes it (resumeAgePrunes at boot). It walks the account's runs by rowid,
// then each run's results a slice at a time (run-results-walk.ts), and counts
// the stored answers again when it's done.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { HEAVY_JOB_RETRY_MS } from '../lib/constants';
import { asBulkWriter } from '../lib/bulk-slices';
import { pruneAnswers } from './answer-prune';
import { walkRunResults } from './run-results-walk';
import { countStoredAnswers } from './answer-store-size';

interface AgeJob {
  id: string; user_id: string; before: string; run_cursor: number; row_cursor: number;
  row_generation: number | null; status: string;
}
interface RunAt { rid: number; id: string; sheet_id: string; due: number }

const ATTEMPTS = 5;
const running = new Set<string>();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const loadJob = (id: string) =>
  db.prepare('SELECT * FROM answer_prune_jobs WHERE id = ?').get(id) as AgeJob | undefined;

export type StartAgePrune = { ok: { jobId: string } } | { fail: 'conflict'; message: string };

export function startAgePrune(userId: string, days: number): StartAgePrune {
  const jobId = uuidv4();
  const started = db.transaction(() => {
    const busy = db.prepare(`SELECT 1 FROM answer_prune_jobs WHERE user_id = ? AND status = 'running'`).get(userId);
    if (busy) return false;
    db.prepare(`INSERT INTO answer_prune_jobs (id, user_id, before) VALUES (?, ?, datetime('now', ?))`)
      .run(jobId, userId, `-${days} days`);
    return true;
  }).immediate();
  if (!started) return { fail: 'conflict', message: 'Old answers are already being pruned.' };
  runAgeJob(jobId);
  return { ok: { jobId } };
}

// The next run at or after the cursor, and whether its answers are due:
// an enrichment run that ended before the cutoff.
function nextRun(job: AgeJob): RunAt | undefined {
  return db.prepare(`SELECT rowid AS rid, id, sheet_id,
      (status IN ('completed', 'failed', 'cancelled') AND updated_at < ?
        AND json_type(config, '$.enrichment') IS NOT NULL) AS due
    FROM http_runs WHERE user_id = ? AND rowid >= ? ORDER BY rowid LIMIT 1`)
    .get(job.before, job.user_id, job.run_cursor) as RunAt | undefined;
}

const moveTo = (jobId: string, rid: number) => db.prepare(`UPDATE answer_prune_jobs SET run_cursor = ?,
  row_cursor = -1, row_generation = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'running'`)
  .run(rid, jobId);

// Prunes from where the job got to; false when it must wait (a busy sheet).
// One bulk writer for the whole pass (lib/bulk-slices.ts): each step past a
// run, and each slice of a run's walk, is one of its transactions, its WAL
// copied back on the checkpoint worker's thread.
async function work(jobId: string): Promise<boolean> {
  return asBulkWriter(async bulk => {
    for (;;) {
      // Where the job got to, and the run there: a run that isn't due is passed in the same transaction.
      const at = await bulk.slice((): { job: AgeJob; run: RunAt } | 'over' | 'passed' => {
        const job = loadJob(jobId);
        if (!job || job.status !== 'running') return 'over';
        const run = nextRun(job);
        if (!run) {
          db.prepare(`UPDATE answer_prune_jobs SET status = 'done', updated_at = datetime('now') WHERE id = ?`)
            .run(jobId);
          return 'over';
        }
        if (!run.due) { moveTo(jobId, run.rid + 1); return 'passed'; }
        return { job, run };
      });
      if (at === 'over') return true;
      if (at === 'passed') continue;
      const { job, run } = at;
      const save = db.prepare(`UPDATE answer_prune_jobs SET pruned = pruned + ?, run_cursor = ?, row_cursor = ?,
        row_generation = ?, updated_at = datetime('now') WHERE id = ? AND status = 'running'`);
      const outcome = await walkRunResults({
        runId: run.id, sheetId: run.sheet_id, userId: job.user_id, answered: true, bulk,
        from: run.rid === job.run_cursor
          ? { cursor: job.row_cursor, generation: job.row_generation } : { cursor: -1, generation: null },
        step: (slice, to) => {
          save.run(pruneAnswers(job.user_id, slice.rowids), run.rid, to.cursor, to.generation, jobId);
        },
      });
      if (outcome === 'busy') return false;
      await bulk.slice(() => moveTo(jobId, run.rid + 1));
    }
  });
}

function runAgeJob(jobId: string): void {
  const job = loadJob(jobId);
  if (!job || running.has(jobId)) return;
  running.add(jobId);
  void (async () => {
    let failures = 0;
    for (;;) {
      try {
        if (await work(jobId)) break;
        failures = 0;
        await sleep(HEAVY_JOB_RETRY_MS);
      } catch (err) {
        console.error(`Pruning old answers (job ${jobId}) failed, retrying:`, err);
        if (++failures >= ATTEMPTS) {
          db.prepare(`UPDATE answer_prune_jobs SET status = 'failed', error_message = ?, updated_at = datetime('now')
            WHERE id = ?`).run(String((err as Error)?.message ?? err).slice(0, 500), jobId);
          break;
        }
        await sleep(HEAVY_JOB_RETRY_MS);
      }
    }
    running.delete(jobId);
    countStoredAnswers(job.user_id, true);
  })();
}

export const agePruneRunning = (userId: string): boolean =>
  !!db.prepare(`SELECT 1 FROM answer_prune_jobs WHERE user_id = ? AND status = 'running'`).get(userId);

// At boot: finish what a restart interrupted.
export function resumeAgePrunes(): void {
  const ids = db.prepare(`SELECT id FROM answer_prune_jobs WHERE status = 'running'`).pluck().all() as string[];
  for (const id of ids) runAgeJob(id);
}
