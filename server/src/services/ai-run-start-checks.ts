// Column checks for a single-column AI run start (ai-run-start.ts).
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { columnReuseCollision } from '../lib/column-names';

// The conflict message for the run's "(Output)" (and "(Data)") column, or null.
export function runColumnConflict(
  sheetId: string, userId: string, outputCol: string, dataCol: string | null,
): string | null {
  // Reject a case/token collision with a DIFFERENT existing column, like every
  // other column-creation site. columnReuseCollision fast-paths self-reuse (the
  // run writing to its own existing column). Non-self-healing read (no txn here).
  const existingColumns = getSheetColumns(sheetId, userId, false);
  for (const candidate of dataCol ? [outputCol, dataCol] : [outputCol]) {
    const conflictMsg = columnReuseCollision(candidate, existingColumns);
    if (conflictMsg) return conflictMsg;
  }
  // "(Data)" reuse is for this column's own earlier runs. One a structured run
  // owns (ai_runs.data_column) isn't ours to write: two runs would overwrite
  // each other's sources, and a cancel of either would clear the other's cells.
  if (dataCol && db.prepare(
    'SELECT 1 FROM ai_runs WHERE sheet_id = ? AND user_id = ? AND data_column = ? LIMIT 1',
  ).get(sheetId, userId, dataCol)) {
    return `"${dataCol}" holds the sources of a structured run. Use a different column name for this run.`;
  }
  return null;
}
