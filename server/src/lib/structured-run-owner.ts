// Which structured AI run (output_columns) owns a column: its status column, one
// of its typed columns, or its "(Data)" sources column. Rerun uses it to rerun
// exactly the run behind the column the user picked; a single-column start uses
// it so it never writes into a structured run's columns.
import { db } from './db';

// The typed column names in an ai_runs.output_columns value; [] if malformed.
export function outputColumnNames(json: string): string[] {
  try {
    const specs = JSON.parse(json) as Array<{ columnName?: unknown }>;
    return Array.isArray(specs) ? specs.map(s => s?.columnName).filter((n): n is string => typeof n === 'string') : [];
  } catch {
    return [];
  }
}

export interface StructuredRunColumns { status_column: string; output_columns: string; data_column: string | null }

// The status column (= ai_runs.column_name) of the newest structured run on the
// sheet that `match` accepts, or null. Reads only the sheet's own ai_runs rows.
// A deleted status column detaches its run (status_column NULL): never matched.
export function findStructuredRun(
  sheetId: string, userId: string, match: (run: StructuredRunColumns) => boolean,
): string | null {
  const runs = db.prepare(`
    SELECT status_column, output_columns, data_column FROM ai_runs
    WHERE sheet_id = ? AND user_id = ? AND output_columns IS NOT NULL AND status_column IS NOT NULL
    ORDER BY created_at DESC, rowid DESC
  `).all(sheetId, userId) as StructuredRunColumns[];
  return runs.find(match)?.status_column ?? null;
}

export function structuredRunOwning(sheetId: string, userId: string, column: string): string | null {
  return findStructuredRun(sheetId, userId, r =>
    r.status_column === column || r.data_column === column || outputColumnNames(r.output_columns).includes(column));
}
