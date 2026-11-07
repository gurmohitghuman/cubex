// A run that ended before it wrote a row (cancelled, failed, or failed to
// start while its rows still held ⏳): its clear has put every cell back to
// what it held before the run (lib/run-undo/clear-back.ts), so undoing it
// would change nothing, and as the newest run of its columns it would stand
// in the way of undoing the run before it. Once the clear is done its journal
// goes: marked 'dropping' (its rows go a slice at a time with the old ones,
// services/run-undo-prune.ts), it reads as no journal at all
// (services/run-undo-view.ts: nothing to undo, it wrote no cells), and no undo
// takes it. "Wrote no row": no result row for the run (every row a run takes
// leaves one, answered or failed) and nothing in its journal but its ⏳ (an
// "Only run if" rule's marks go in at the start, with no result row). Plain DB
// work: a run worker's clear (a failed run) does it too.
import { db } from '../db';
import { UNDO_EMPTY_CHECK_ROWS } from '../constants';
import { yieldToRequests } from '../slices';
import { PRINT_RUNNING } from './print';
import type { RunRef } from './journal';

const RESULTS: Record<RunRef['kind'], string> = { ai: 'ai_results', http: 'http_results' };

export async function dropUnusedJournal(run: RunRef, userId: string): Promise<boolean> {
  const results = RESULTS[run.kind];
  const j = db.prepare(`SELECT id FROM run_undos WHERE run_kind = ? AND run_id = ? AND user_id = ?
    AND state = 'kept'`).pluck().get(run.kind, run.id, userId) as number | undefined;
  if (j === undefined || db.prepare(`SELECT 1 FROM ${results} WHERE run_id = ? LIMIT 1`).get(run.id)) return false;
  // A page of its rows at a time (a run of a million rows keeps a million): the last one's row_id, and
  // whether any of its cells holds the print of something other than the run's ⏳.
  const page = db.prepare(`SELECT MAX(row_id), MAX(EXISTS (SELECT 1 FROM json_each(cells) c
      WHERE c.value ->> 2 IS NOT ${PRINT_RUNNING}))
    FROM (SELECT row_id, cells FROM run_undo_rows WHERE undo_id = ? AND row_id > ? ORDER BY row_id LIMIT ?)`).raw();
  for (let after = 0; ;) {
    const [last, wrote] = page.get(j, after, UNDO_EMPTY_CHECK_ROWS) as [number | null, number | null];
    if (wrote) return false;
    if (last === null) break;
    after = last;
    await yieldToRequests();
  }
  return db.prepare(`UPDATE run_undos SET state = 'dropping' WHERE id = ? AND state = 'kept'
    AND NOT EXISTS (SELECT 1 FROM ${results} WHERE run_id = ?)`).run(j, run.id).changes > 0;
}
