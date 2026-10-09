// Walking one run's results (http_results) a slice at a time in row_index
// order, for background jobs that read or rewrite stored answers (prunes, the
// stored answers' size). A sort moves results to new row indexes
// (sort-results.ts) with its sheet busy: a slice never runs while the sheet is
// busy, and a walk whose sheet's rows moved since its cursor was taken (the
// row_generation fence) starts over. Each slice reads and does its work in
// one synchronous step, so nothing moves under it; the step must be idempotent.
import { db } from '../lib/db';
import { ANSWER_PRUNE_SLICE } from '../lib/constants';
import { sheetBusyWith } from '../lib/sheet-busy';
import { yieldToRequests } from '../lib/slices';

export interface WalkPos { cursor: number; generation: number | null }
export interface WalkSlice { rowids: number[]; indexes: number[] }

export interface RunWalk {
  runId: string; sheetId: string; userId: string; from: WalkPos;
  // Only results that hold an answer.
  answered?: boolean;
  // One slice's work, and where the walk got to (save it with the work).
  step: (slice: WalkSlice, to: WalkPos) => void;
  // The sheet's rows moved since `from`: the walk starts over (a count drops what it had).
  restarted?: () => void;
}

const generationOf = (sheetId: string, userId: string): number | null =>
  (db.prepare('SELECT row_generation FROM sheets WHERE id = ? AND user_id = ?').pluck()
    .get(sheetId, userId) as number | undefined) ?? null;

// 'done', or 'busy' when the sheet is busy (the caller tries again later; the
// last step saved where it got to).
export async function walkRunResults(w: RunWalk): Promise<'done' | 'busy'> {
  const read = db.prepare(`SELECT rowid, row_index FROM http_results WHERE run_id = ? AND row_index > ?
    AND +user_id = ? ${w.answered ? 'AND response_data IS NOT NULL' : ''} ORDER BY row_index LIMIT ?`);
  let pos = w.from;
  for (;;) {
    if (sheetBusyWith(w.sheetId)) return 'busy';
    const generation = generationOf(w.sheetId, w.userId);
    if (generation === null) return 'done';   // the sheet is gone, and its runs with it
    const moved = pos.generation !== generation && pos.cursor > -1;
    if (moved) w.restarted?.();
    const cursor = moved ? -1 : pos.cursor;
    const rows = read.all(w.runId, cursor, w.userId, ANSWER_PRUNE_SLICE) as
      Array<{ rowid: number; row_index: number }>;
    if (rows.length === 0) return 'done';
    pos = { cursor: rows[rows.length - 1].row_index, generation };
    w.step({ rowids: rows.map(r => r.rowid), indexes: rows.map(r => r.row_index) }, pos);
    if (rows.length < ANSWER_PRUNE_SLICE) return 'done';
    await yieldToRequests();
  }
}
