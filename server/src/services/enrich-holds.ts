// Holds on the enrichment limits while a run's calls are out (migration 020).
// The ledger only moves once a call is answered, and up to four runs size
// their rows at once in worker threads with their own DB connections, so
// counting spend alone would let each buy the same remaining room. Rows are
// sized and held in one IMMEDIATE transaction (enrich-runner.ts): the run's
// hold set to its rows still out (so a release that failed can't pile up),
// spent plus held against the limit, then the hold set to those rows plus the
// new ones, x per-row cap. Each row gives its share back once its calls
// settled (their real cost is in the ledger by then), and the run drops the
// rest when it ends, however it ends.
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

// Sets the worker's hold. Call inside the transaction that checks the limits.
// Also clears the user's holds that no longer count, so nothing stale piles up
// between restarts. aiMicro: a waterfall's AI part, which only its token's
// spend cap counts (services/token-spend.ts); `micro` is treg's.
export function setRunHold(runId: string, userId: string, generation: number, micro: number, aiMicro = 0): void {
  db.prepare(`
    DELETE FROM enrich_holds WHERE user_id = ? AND NOT EXISTS (
      SELECT 1 FROM http_runs r WHERE r.id = enrich_holds.run_id AND r.user_id = enrich_holds.user_id
        AND ((r.status = 'running' AND r.worker_generation = enrich_holds.worker_generation)
          OR r.updated_at > datetime('now', ?)))
  `).run(userId, GRACE);
  if (micro <= 0 && aiMicro <= 0) { dropHold(runId, generation); return; }
  db.prepare(`
    INSERT INTO enrich_holds (run_id, worker_generation, user_id, hold_micro, ai_hold_micro) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(run_id, worker_generation) DO UPDATE SET hold_micro = excluded.hold_micro,
      ai_hold_micro = excluded.ai_hold_micro
  `).run(runId, generation, userId, Math.max(0, micro), Math.max(0, aiMicro));
}

// One row settled, or held room no row took. Never throws: the run drops the
// whole hold at its end anyway.
export function releaseRow(runId: string, generation: number, micro: number, aiMicro = 0): void {
  if (micro <= 0 && aiMicro <= 0) return;
  try {
    db.prepare(`UPDATE enrich_holds SET hold_micro = MAX(0, hold_micro - ?), ai_hold_micro = MAX(0, ai_hold_micro - ?)
      WHERE run_id = ? AND worker_generation = ?`).run(Math.max(0, micro), Math.max(0, aiMicro), runId, generation);
  } catch (err) {
    console.error(`Enrichment run ${runId}: releasing a row's hold failed:`, (err as Error).message);
  }
}

export function dropHold(runId: string, generation: number): void {
  db.prepare('DELETE FROM enrich_holds WHERE run_id = ? AND worker_generation = ?').run(runId, generation);
}

// What the runs done for one access token hold now in micro-USD, treg's part
// and a waterfall's AI part (its spend cap's room, services/token-spend.ts).
// The holds are few: one per run out.
export function tokenHeldMicro(userId: string, tokenId: string): number {
  return db.prepare(`
    SELECT IFNULL(SUM(h.hold_micro + h.ai_hold_micro), 0) FROM enrich_holds h
    JOIN http_runs r ON r.id = h.run_id AND r.user_id = h.user_id
    WHERE h.user_id = ? AND r.access_token_id = ?
      AND ((r.status = 'running' AND r.worker_generation = h.worker_generation) OR r.updated_at > datetime('now', ?))
  `).pluck().get(userId, tokenId, GRACE) as number;
}
