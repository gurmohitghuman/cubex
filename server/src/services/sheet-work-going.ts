// Whether work that writes a sheet's cells is going on it: a run (pending,
// running or paused, or clearing its ⏳), a saved setup filling it, or a clean,
// formula or lookup column being filled (a lookup's may wait, its sheet free, for
// the other sheet or a column there). A setup version's restore and a test of the
// sheet (sheet-test-*.ts) wait for none. Reads the run tables' status, never a row.
import { db } from '../lib/db';

const RUNS_ACTIVE = `SELECT 1 FROM ai_runs WHERE sheet_id = ? AND user_id = ?
    AND (status IN ('pending', 'running', 'paused') OR placeholder_work IS NOT NULL)
  UNION ALL SELECT 1 FROM http_runs WHERE sheet_id = ? AND user_id = ?
    AND (status IN ('pending', 'running', 'paused') OR placeholder_work IS NOT NULL)
  UNION ALL SELECT 1 FROM setup_runs WHERE sheet_id = ? AND user_id = ? AND status IN ('running', 'paused')
  LIMIT 1`;
const FILLING = `SELECT column_name FROM clean_columns WHERE sheet_id = ? AND user_id = ? AND fill_status = 'filling'
  UNION ALL SELECT column_name FROM formula_columns WHERE sheet_id = ? AND user_id = ? AND fill_status = 'filling'
  UNION ALL SELECT column_name FROM lookup_columns WHERE sheet_id = ? AND user_id = ? AND fill_status = 'filling'
  LIMIT 1`;

export type WorkGoing = { run: true } | { filling: string } | null;

export function sheetWorkGoing(sheetId: string, userId: string): WorkGoing {
  const args = [sheetId, userId, sheetId, userId, sheetId, userId];
  if (db.prepare(RUNS_ACTIVE).get(...args)) return { run: true };
  const filling = db.prepare(FILLING).pluck().get(...args) as string | undefined;
  return filling === undefined ? null : { filling };
}
