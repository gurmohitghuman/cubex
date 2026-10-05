import { db } from '../lib/db';

export interface AIRunRow {
  id: string;
  sheet_id: string;
  user_id: string;
  // 'seeding' while the start writes its placeholders, 'clearing' while an
  // ended run's leftovers are cleared (migration 004); null otherwise.
  placeholder_work?: 'seeding' | 'clearing' | null;
  column_name: string;
  prompt: string;
  system_prompt: string | null;
  model: string | null;
  temperature: number | null;
  use_openrouter_web_search: number;
  use_web_fetch: number;
  max_chars: number | null;
  concurrency: number;
  status: string;
  total_rows: number;
  processed_rows: number;
  target_rows: string | null;        // JSON array of row indices for reruns; NULL = full run
  output_columns: string | null;     // JSON [{columnName,type,description}] for structured runs; NULL = single-column (migration 042)
  status_column: string | null;      // per-row ✅/❌ column for structured runs; NULL for single-column
  worker_generation: number;         // bumped on each resume; old workers exit on mismatch
  error_message: string | null;      // run-level failure reason (migration 022); NULL unless failed
  created_at: string;
  updated_at: string;
}

export interface SheetRow {
  rowIndex: number;
  data: Record<string, string>;
}

// Statuses a worker must NOT start processing for. 'cancelled'/'paused' are
// explicit user actions. 'failed'/'completed' are terminal: a worker observing
// one of these is a STALE Sidequest job — either resurrected from jobs.db after
// a deploy (boot marks orphaned runs 'failed' + bumps worker_generation, but the
// stale job reads the already-bumped generation so the generation guard can't
// catch it), or auto-retried after a crash. Starting it would re-spend API
// credits and overwrite cells the user already has. Shared by both runners'
// startup guard. NOTE: this is a different question from shouldStop() — that
// governs mid-run continuation; this governs whether to start at all.
export function shouldNotStartRun(status: string): boolean {
  return status === 'cancelled' || status === 'paused'
    || status === 'failed' || status === 'completed';
}

// Cheap status read used at every loop iteration. Indexed by id (PK) so it's a
// single B-tree lookup. Returns null if the row was deleted (e.g. sheet/table cascade).
export function getRunStatusAndGen(runId: string): { status: string; generation: number } | null {
  const row = db.prepare('SELECT status, worker_generation FROM ai_runs WHERE id = ?')
    .get(runId) as { status: string; worker_generation: number } | undefined;
  return row ? { status: row.status, generation: row.worker_generation } : null;
}

// True if the worker should stop processing rows. Triggered by:
//   - run was paused/cancelled by an API request (status check)
//   - run vanished (sheet/table CASCADE-deleted)
//   - worker_generation moved past what this worker captured at startup — means a
//     resume happened while we were running, and a new worker is already on it.
//     Old worker exits to avoid double-processing.
export function shouldStop(runId: string, capturedGeneration: number): boolean {
  const cur = getRunStatusAndGen(runId);
  if (cur === null) return true;
  if (cur.status === 'paused' || cur.status === 'cancelled') return true;
  return cur.generation !== capturedGeneration;
}
