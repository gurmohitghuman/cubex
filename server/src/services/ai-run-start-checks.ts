// Column checks for an AI run start (ai-run-start.ts, ai-run-start-multi.ts).
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { columnReuseCollision } from '../lib/column-names';
import { structuredRunOwning } from '../lib/structured-run-owner';

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
  // Reuse is for this column's own earlier runs. A column a structured run owns
  // (its status, a typed or its "(Data)" column) isn't ours to write: two runs
  // would overwrite each other, and a cancel of either would clear the other's cells.
  for (const candidate of dataCol ? [outputCol, dataCol] : [outputCol]) {
    if (structuredRunOwning(sheetId, userId, candidate)) {
      return `"${candidate}" belongs to an AI run that fills several columns. Use a different column name for this run.`;
    }
  }
  return null;
}

// Is a run on this column still active? Two runs would race over the same
// cells. A stopped run still clearing its ⏳ cells (migration 004) counts: its
// clear would wipe the new run's placeholders in rows it hasn't reached.
export function activeRunOnColumn(sheetId: string, userId: string, column: string): boolean {
  return !!db.prepare(`
    SELECT id FROM ai_runs
    WHERE sheet_id = ? AND user_id = ? AND column_name = ?
      AND (status IN ('pending','running','paused') OR placeholder_work IS NOT NULL)
    LIMIT 1
  `).get(sheetId, userId, column);
}
