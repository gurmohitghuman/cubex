// The columns a run column's setup reads now: the newest run filling it. Column runs (services/column-run-plan.ts)
// order the chosen columns by it, so a column that reads another chosen one runs after it. Out of date is decided
// per row from the list its own run read (services/run-inputs.ts), not from this.
import { db } from '../lib/db';
import {
  aiRunInputColumns, requestRunInputColumns, type AiInputFields, type RunInputList,
} from '../lib/run-inputs/columns';
import type { HTTPAPIConfig } from '../lib/http-request-template';

// The columns the newest run filling `main` reads, or null when no run fills it.
// An AI run wins over an HTTP one of the same name, as in lib/column-types.ts.
export function columnRunInputs(
  sheetId: string, userId: string, main: string, columns: readonly string[],
): RunInputList | null {
  const ai = db.prepare(`SELECT column_name, prompt, output_columns, data_column, use_openrouter_web_search
    FROM ai_runs WHERE sheet_id = ? AND user_id = ? AND column_name = ? ORDER BY rowid DESC LIMIT 1`)
    .get(sheetId, userId, main) as AiInputFields | undefined;
  if (ai) return aiRunInputColumns(ai, columns);
  // MAX(rowid) over the (sheet, column) index: an auto-run column holds a run per batch.
  const config = db.prepare(`SELECT config FROM http_runs WHERE rowid = (SELECT MAX(rowid) FROM http_runs
    WHERE sheet_id = ? AND master_column_name = ?) AND user_id = ?`).pluck()
    .get(sheetId, main, userId) as string | null | undefined;
  if (!config) return null;
  try {
    return requestRunInputColumns(JSON.parse(config) as HTTPAPIConfig, main, [...columns]);
  } catch { return null; }
}
