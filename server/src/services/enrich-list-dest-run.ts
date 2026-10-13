// List results that replace rows a run on their destination may still fill.
// Adding a source row's results again removes the rows it added before; under
// a run on that sheet that hasn't ended, that would leave the run's results
// nowhere, so they wait, as a row delete does (a paused run too: its calls in
// flight still answer, and a resume goes on by row). The drain moves on to the
// next source row's results meanwhile (services/enrich-list-drain.ts). A
// pending or running run ends by itself: its results still count as being
// added (a new run on the column waits). A paused one may not: the journal row
// records the wait ('dest_run'), its source row names the run and says to
// resume or cancel it, and it no longer holds the column; it goes back to the
// queue once that run is resumed or ends.
import { db } from '../lib/db';

export interface DestRun { column: string | null; paused: boolean }

// A run on the destination that hasn't ended, a paused one first (it won't
// end by itself, so the source row names it). The HTTP side repeats the
// active-run index's WHERE word for word (migration 014): a sheet auto-run
// fills can hold thousands of runs.
export function destRunBlocker(destId: string, userId: string): DestRun | null {
  const r = db.prepare(`SELECT master_column_name AS col, status = 'paused' AS paused FROM http_runs
      WHERE sheet_id = ? AND user_id = ?
        AND (status IN ('pending', 'running', 'paused') OR placeholder_work IS NOT NULL)
        AND status IN ('pending', 'running', 'paused')
    UNION ALL SELECT column_name AS col, status = 'paused' AS paused FROM ai_runs
      WHERE sheet_id = ? AND user_id = ? AND status IN ('pending', 'running', 'paused')
    ORDER BY paused DESC LIMIT 1`).get(destId, userId, destId, userId) as
    { col: string | null; paused: number } | undefined;
  return r ? { column: r.col, paused: r.paused === 1 } : null;
}

// An older journal row of the same source row and column waits for a paused
// run there: this one waits behind it, or it would land first and then be
// replaced by the older results.
export function olderWaitsForRun(
  j: { id: string; source_row_id: string; source_sheet_id: string; dest_sheet_id: string }, column: string,
): boolean {
  return !!db.prepare(`SELECT 1 FROM enrichment_list_items li JOIN http_runs r ON r.id = li.run_id
    WHERE li.source_row_id = ? AND li.status = 'pending' AND li.wait_reason = 'dest_run' AND li.dest_sheet_id = ?
      AND li.rowid < (SELECT rowid FROM enrichment_list_items WHERE id = ?)
      AND r.sheet_id = ? AND r.master_column_name = ? LIMIT 1`)
    .get(j.source_row_id, j.dest_sheet_id, j.id, j.source_sheet_id, column);
}

// At the start of each drain round: destinations with results waiting for a
// paused run there, and none paused anymore, let them go (oldest first, as ever).
export function releaseDestRunWaits(): void {
  const dests = db.prepare(`SELECT DISTINCT dest_sheet_id FROM enrichment_list_items
    WHERE status = 'pending' AND wait_reason = 'dest_run'`).pluck().all() as string[];
  for (const dest of dests) {
    const owner = db.prepare('SELECT user_id FROM sheets WHERE id = ?').pluck().get(dest) as string | undefined;
    if (!owner || destRunBlocker(dest, owner)?.paused) continue;
    db.prepare(`UPDATE enrichment_list_items SET wait_reason = NULL, updated_at = datetime('now')
      WHERE dest_sheet_id = ? AND status = 'pending' AND wait_reason = 'dest_run' AND user_id = ?`).run(dest, owner);
  }
}
