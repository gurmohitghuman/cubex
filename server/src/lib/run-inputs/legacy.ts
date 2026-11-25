// Stamps written before migration 066 name no input list (lib/run-inputs/sets.ts):
// they were made against the columns of their column's newest run, which the
// migration noted per key. Once, at boot before the server serves, those
// columns become the key's legacy_set, a list as any other, so later renames
// rewrite it and a newer setup leaves it alone. A key whose run is gone (or
// unreadable) keeps none: its old stamps never read out of date.
import { db } from '../db';
import { getSheetColumns } from '../sql-helpers';
import { aiRunInputColumns, requestRunInputColumns, type AiInputFields, type RunInputList } from './columns';
import { ensureRunInputSet } from './sets';
import type { HTTPAPIConfig } from '../http-request-template';

interface LegacyKey {
  id: number; user_id: string; sheet_id: string; column_name: string;
  legacy_ai_run: string | null; legacy_http_run: string | null;
}

// The columns the noted run reads, as the reader before 066 worked them out.
function noteInputs(k: LegacyKey): RunInputList | null {
  const columns = getSheetColumns(k.sheet_id, k.user_id, false);
  if (k.legacy_ai_run) {
    const ai = db.prepare(`SELECT column_name, prompt, output_columns, data_column, use_openrouter_web_search
      FROM ai_runs WHERE id = ? AND sheet_id = ? AND user_id = ?`)
      .get(k.legacy_ai_run, k.sheet_id, k.user_id) as AiInputFields | undefined;
    if (ai) return aiRunInputColumns({ ...ai, column_name: k.column_name }, columns);
  }
  if (!k.legacy_http_run) return null;
  const config = db.prepare('SELECT config FROM http_runs WHERE id = ? AND sheet_id = ? AND user_id = ?').pluck()
    .get(k.legacy_http_run, k.sheet_id, k.user_id) as string | null | undefined;
  if (!config) return null;
  return requestRunInputColumns(JSON.parse(config) as HTTPAPIConfig, k.column_name, columns);
}

export function adoptLegacyRunInputs(): void {
  const keys = db.prepare(`SELECT id, user_id, sheet_id, column_name, legacy_ai_run, legacy_http_run
    FROM run_input_keys WHERE legacy_ai_run IS NOT NULL OR legacy_http_run IS NOT NULL`).all() as LegacyKey[];
  const done = db.prepare(`UPDATE run_input_keys SET legacy_set = ?, legacy_ai_run = NULL, legacy_http_run = NULL
    WHERE id = ? AND user_id = ?`);
  for (const k of keys) {
    db.transaction(() => {
      let inputs: RunInputList | null = null;
      try { inputs = noteInputs(k); } catch { /* an unreadable setup: no list */ }
      done.run(inputs ? ensureRunInputSet(k.id, k.user_id, inputs) : null, k.id, k.user_id);
    }).immediate();
  }
}
