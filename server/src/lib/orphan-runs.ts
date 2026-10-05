import { db } from './db';

// Recovered run IDs from a boot reset, split by kind. The caller re-enqueues
// these AFTER the queue is up (resetOrphanedRuns runs before Sidequest starts).
export interface RecoveredRuns {
  aiRunIds: string[];
  httpRunIds: string[];
}

// On boot, RESUME runs that were mid-flight ('running'/'pending') when the
// previous process died (crash / SIGKILL / redeploy). This is the industry-
// standard durable-queue pattern: process state is in the DB, and on startup we
// reclaim and re-run interrupted work rather than discarding it.
//
// PREVIOUSLY this marked them 'failed' + cleared their "⏳ Processing..."
// placeholders, so a redeploy mid-run silently killed the run and blanked the
// in-progress cells (the user had to manually stop + re-run). That was the right
// fix BEFORE the run-safety guards existed; now that worker_generation +
// shouldNotStartRun + the pending→running CAS are in place (HISTORY § run-safety),
// failing on every restart is overkill and hurts the common case.
//
// What we do instead — mirroring the manual resume handler (ai-control.ts /
// http-jobs.ts):
//   - PRESERVE the "⏳ Processing..." placeholders. They are ground truth for
//     which rows still need processing; the runners resume placeholder-driven
//     (only cells still holding ⏳ are reprocessed). Completed rows and rows that
//     already resolved to "❌ Error" (an OpenRouter failure) no longer carry the
//     placeholder, so they are NOT re-run or re-billed.
//   - status → 'pending'; bump worker_generation (so any worker that somehow
//     survived self-terminates on its next check instead of double-writing).
//   - return the run IDs so startQueue() re-enqueues them once Sidequest is up,
//     re-dispatching reruns via their stored target_rows.
//
// Statuses we DON'T touch (intentional): 'paused' (the user paused; resume is
// their action), 'cancelled' (the user killed it — never revive), 'completed',
// 'failed'. Only genuinely-interrupted 'running'/'pending' runs are recovered.
export function resetOrphanedRuns(): RecoveredRuns {
  // A run still writing its placeholders when the process died was never
  // queued, and resuming it would process only the rows seeded so far
  // (services/run-seed.ts). Fail it instead; resumeRunCleanups clears its cells
  // once the server is up.
  for (const table of ['ai_runs', 'http_runs']) {
    const failed = db.prepare(
      `UPDATE ${table}
         SET status = 'failed',
             error_message = 'Cubex restarted while this run was starting. Start it again.',
             placeholder_work = 'clearing',
             updated_at = datetime('now')
       WHERE placeholder_work = 'seeding'`,
    ).run();
    if (failed.changes > 0) console.log(`⚠️  ${failed.changes} run(s) in ${table} were starting when Cubex stopped; marked failed`);
  }

  const aiRunIds = (db.prepare(
    `SELECT id FROM ai_runs WHERE status IN ('running', 'pending')`,
  ).all() as Array<{ id: string }>).map(r => r.id);

  const httpRunIds = (db.prepare(
    `SELECT id FROM http_runs WHERE status IN ('running', 'pending')`,
  ).all() as Array<{ id: string }>).map(r => r.id);

  // Flip to 'pending' + bump generation. Placeholders are deliberately left in
  // place (the resume reprocesses exactly the ⏳ rows).
  const ai = db.prepare(
    `UPDATE ai_runs
       SET status = 'pending',
           error_message = NULL,
           worker_generation = worker_generation + 1,
           updated_at = datetime('now')
     WHERE status IN ('running', 'pending')`,
  ).run();
  const http = db.prepare(
    `UPDATE http_runs
       SET status = 'pending',
           error_message = NULL,
           worker_generation = worker_generation + 1,
           updated_at = datetime('now')
     WHERE status IN ('running', 'pending')`,
  ).run();

  if (ai.changes > 0 || http.changes > 0) {
    console.log(
      `🔄 Recovering ${ai.changes} interrupted AI run(s) and ${http.changes} interrupted HTTP run(s) from previous process — will resume after queue start`,
    );
  }
  return { aiRunIds, httpRunIds };
}
