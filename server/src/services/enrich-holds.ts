// Holds on the enrichment limits while a batch's calls are out (migration 020).
// The ledger only moves once a call is answered, and up to four runs size
// their batches at once in worker threads with their own DB connections, so
// counting spend alone would let each buy the same remaining room. A batch is
// sized and held in one IMMEDIATE transaction (enrich-runner.ts): spent plus
// held against the limit, then rows x per-row cap. Each row gives its share
// back once its calls settled (their real cost is in the ledger by then), and
// the batch drops the rest when it ends, however it ends.
//
// A hold counts while its run is running under the worker that took it, or
// for a grace period after the run last changed (paused, cancelled, resumed):
// calls already out still finish and bill. A worker that died with its hold is
// a dead process, and boot deletes every hold (lib/orphan-runs.ts).
import { db } from '../lib/db';
import { ENRICH_HOLD_GRACE_SEC } from '../lib/constants';

const GRACE = `-${ENRICH_HOLD_GRACE_SEC} seconds`;

// What the user's batches hold now in micro-USD, or one run's (null: every run).
export function heldMicro(userId: string, runId: string | null = null): number {
  return db.prepare(`
    SELECT IFNULL(SUM(h.hold_micro), 0) FROM enrich_holds h
    WHERE h.user_id = ? AND (? IS NULL OR h.run_id = ?)
      AND EXISTS (SELECT 1 FROM http_runs r WHERE r.id = h.run_id AND r.user_id = h.user_id
        AND ((r.status = 'running' AND r.worker_generation = h.worker_generation) OR r.updated_at > datetime('now', ?)))
  `).pluck().get(userId, runId, runId, GRACE) as number;
}

// Call inside the transaction that checked the limits. Also clears the user's
// holds that no longer count, so nothing stale piles up between restarts.
export function takeHold(runId: string, userId: string, generation: number, micro: number): void {
  db.prepare(`
    DELETE FROM enrich_holds WHERE user_id = ? AND NOT EXISTS (
      SELECT 1 FROM http_runs r WHERE r.id = enrich_holds.run_id AND r.user_id = enrich_holds.user_id
        AND ((r.status = 'running' AND r.worker_generation = enrich_holds.worker_generation)
          OR r.updated_at > datetime('now', ?)))
  `).run(userId, GRACE);
  if (micro <= 0) return;
  db.prepare(`
    INSERT INTO enrich_holds (run_id, worker_generation, user_id, hold_micro) VALUES (?, ?, ?, ?)
    ON CONFLICT(run_id, worker_generation) DO UPDATE SET hold_micro = excluded.hold_micro
  `).run(runId, generation, userId, micro);
}

// A batch that found fewer rows than it held gives the rest back.
export function setHold(runId: string, generation: number, micro: number): void {
  db.prepare('UPDATE enrich_holds SET hold_micro = ? WHERE run_id = ? AND worker_generation = ?')
    .run(Math.max(0, micro), runId, generation);
}

// One row settled. Never throws: the batch drops the whole hold at its end anyway.
export function releaseRow(runId: string, generation: number, micro: number): void {
  if (micro <= 0) return;
  try {
    db.prepare(`UPDATE enrich_holds SET hold_micro = MAX(0, hold_micro - ?)
      WHERE run_id = ? AND worker_generation = ?`).run(micro, runId, generation);
  } catch (err) {
    console.error(`Enrichment run ${runId}: releasing a row's hold failed:`, (err as Error).message);
  }
}

export function dropHold(runId: string, generation: number): void {
  db.prepare('DELETE FROM enrich_holds WHERE run_id = ? AND worker_generation = ?').run(runId, generation);
}
