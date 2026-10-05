import { db } from '../lib/db';

export interface HTTPRunRow {
  id: string;
  sheet_id: string;
  user_id: string;
  // 'seeding' while the start writes its placeholders, 'clearing' while an
  // ended run's leftovers are cleared (migration 004); null otherwise.
  placeholder_work?: 'seeding' | 'clearing' | null;
  config: string;
  status: string;
  total_rows: number;
  processed_rows: number;
  master_column_name: string | null;
  worker_generation: number;
  error_message: string | null;      // run-level failure reason (migration 022); NULL unless failed
  target_rows: string | null;        // JSON row-index array for reruns (migration 024); NULL for full runs
  allow_secrets: number;             // run-level saved-key policy (migration 034); 0 = fallback disabled
  created_at: string;
  updated_at: string;
}

export function getRunStatusAndGen(runId: string): { status: string; generation: number } | null {
  const row = db.prepare(
    'SELECT status, worker_generation FROM http_runs WHERE id = ?',
  ).get(runId) as { status: string; worker_generation: number } | undefined;
  return row ? { status: row.status, generation: row.worker_generation } : null;
}

// Statuses a worker must NOT start processing for. 'cancelled'/'paused' are
// explicit user actions. 'failed'/'completed' are terminal: a worker observing
// one of these is a STALE Sidequest job — either resurrected from jobs.db after
// a deploy (boot marks orphaned runs 'failed' + bumps worker_generation, but the
// stale job reads the already-bumped generation so the generation guard can't
// catch it), or auto-retried after a crash. Starting it would re-spend API
// credits and overwrite cells the user already has. Mirrors the AI runner's
// shouldNotStartRun. NOTE: distinct from the mid-run shouldStop() check.
export function shouldNotStartRun(status: string): boolean {
  return status === 'cancelled' || status === 'paused'
    || status === 'failed' || status === 'completed';
}
