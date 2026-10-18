// What makes a run column's results out of date now (lib/run-inputs): its key
// in rows.run_inputs and the columns its NEWEST run reads. A result a run made
// from other columns (its setup was edited since to read different ones) reads
// as out of date too: it wasn't made from what the column reads now. Read per
// request: a few small queries, one newest run per column, never every run.
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { runInputKey, sheetRunInputKeys } from '../lib/run-inputs/keys';
import {
  aiRunInputColumns, requestRunInputColumns, type AiInputFields, type RunInputList,
} from '../lib/run-inputs/columns';
import { staleSql, type RunInputs } from '../lib/run-inputs/stale-sql';
import type { CompiledFilter } from '../lib/row-filter/sql';
import type { HTTPAPIConfig } from '../lib/http-request-template';
import { statusReadsStale, type EnrichRowsStatus } from '../lib/enrich-run-config';

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

// Every run column of the sheet a run has fingerprinted rows of → its key and inputs.
export function sheetRunInputs(sheetId: string, userId: string, columns?: readonly string[]): Map<string, RunInputs> {
  const keys = sheetRunInputKeys(sheetId, userId);
  const out = new Map<string, RunInputs>();
  if (keys.size === 0) return out;
  const sheetColumns = columns ?? getSheetColumns(sheetId, userId, false);
  for (const [main, key] of keys) {
    if (!sheetColumns.includes(main)) continue;
    const inputs = columnRunInputs(sheetId, userId, main, sheetColumns);
    if (inputs) out.set(main, { key, inputs });
  }
  return out;
}

// The out-of-date check of one run column (its main column), or null when no
// run has fingerprinted a row of it: rerun targets and counts select it.
export function columnStaleCheck(sheetId: string, userId: string, main: string): CompiledFilter | null {
  const key = runInputKey(sheetId, userId, main);
  if (key === null) return null;
  const inputs = columnRunInputs(sheetId, userId, main, getSheetColumns(sheetId, userId, false));
  return inputs ? staleSql({ key, inputs }) : null;
}

// An enrichment or waterfall run's seeding and counts: the check, when the
// rows it takes depend on it (an out_of_date status on a column a run made).
export function statusStaleCheck(
  sheetId: string, userId: string, statusColumn: string | null, status: EnrichRowsStatus,
): CompiledFilter | null {
  return statusColumn !== null && statusReadsStale(status) ? columnStaleCheck(sheetId, userId, statusColumn) : null;
}

// For a run-state filter: the out-of-date check of a state column, read once
// per sheet when a filter first asks (lib/row-filter/sql.ts staleFor).
export function staleLookup(sheetId: string, userId: string, columns: readonly string[]) {
  let inputs: Map<string, RunInputs> | null = null;
  return (state: string): CompiledFilter | null => {
    inputs ??= sheetRunInputs(sheetId, userId, columns);
    const r = inputs.get(state);
    return r ? staleSql(r) : null;
  };
}
