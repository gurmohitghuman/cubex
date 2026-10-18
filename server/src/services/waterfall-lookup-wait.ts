// When a waterfall lookup step waits instead of answering (in the job thread,
// from the database: the API thread's busy map isn't here). A miss sends the
// row on to the paid steps, so the step never answers from a sheet half-way
// through moving its rows: while that sheet is being imported into (or
// replaced), sorted, cleared of duplicates or having a column renamed or
// deleted (each leaves its journal row until done), and, for one row, while
// the cell it would return holds a run's ⏳ and a run there is still going.
// A paused run doesn't hold it: its ⏳ reads empty, as a run's words do.
import { db } from '../lib/db';
import { getLockedRunColumns } from '../lib/run-locked-columns';

const JOBS = `SELECT EXISTS (SELECT 1 FROM import_jobs WHERE sheet_id = @s AND user_id = @u)
  OR EXISTS (SELECT 1 FROM sort_jobs WHERE sheet_id = @s AND user_id = @u)
  OR EXISTS (SELECT 1 FROM dedupe_jobs WHERE sheet_id = @s AND user_id = @u AND stage = 'deleting')
  OR EXISTS (SELECT 1 FROM column_purges WHERE sheet_id = @s AND user_id = @u)`;

export function otherSheetMoving(sheetId: string, userId: string): boolean {
  return db.prepare(JOBS).pluck().get({ s: sheetId, u: userId }) === 1;
}

const RUNNING = `SELECT EXISTS (SELECT 1 FROM http_runs WHERE sheet_id = @s AND user_id = @u
    AND status IN ('pending', 'running'))
  OR EXISTS (SELECT 1 FROM ai_runs WHERE sheet_id = @s AND user_id = @u AND status IN ('pending', 'running'))`;

// The matched row's cell holds a run's ⏳ and a run there still fills that column.
export function cellStillFilling(raw: unknown, sheetId: string, userId: string, column: string): boolean {
  if (typeof raw !== 'string' || !raw.startsWith('⏳')) return false;
  return getLockedRunColumns(sheetId, userId).has(column)
    && db.prepare(RUNNING).pluck().get({ s: sheetId, u: userId }) === 1;
}
