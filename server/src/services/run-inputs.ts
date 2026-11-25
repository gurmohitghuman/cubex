// What makes a run column's results out of date now (lib/run-inputs): its key
// in rows.run_inputs and the input lists its stamps name (lib/run-inputs/sets.ts),
// each resolved against the sheet's columns now (a gone column reads empty).
// Each row is checked against the list its own run read, so a setup that reads
// other columns marks nothing out of date. Stamps from before migration 066
// read against the key's legacy_set (lib/run-inputs/legacy.ts). Read per
// request: a few small queries per column, never every run.
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { runInputSet, runInputSets } from '../lib/run-inputs/sets';
import type { RunInputList } from '../lib/run-inputs/columns';
import { staleSql, type RunInputs, type RunInputSet } from '../lib/run-inputs/stale-sql';
import type { CompiledFilter } from '../lib/row-filter/sql';
import { statusReadsStale, type EnrichRowsStatus } from '../lib/enrich-run-config';

interface KeyRow { id: number; column_name: string; legacy_set: number | null }

// A key's lists, newest first, then the one its pre-066 stamps read against.
function keyInputs(k: KeyRow, userId: string, columns: readonly string[]): RunInputs {
  const resolve = (list: RunInputList): RunInputList => list.map(c => (c !== null && columns.includes(c) ? c : null));
  const sets: RunInputSet[] = runInputSets(k.id, userId).map(s => ({ id: s.id, inputs: resolve(s.inputs) }));
  const legacy = k.legacy_set === null ? undefined : runInputSet(k.legacy_set, k.id, userId);
  if (legacy) sets.push({ id: null, inputs: resolve(legacy) });
  return { key: k.id, sets };
}

// Every run column of the sheet a run has fingerprinted rows of → its key and inputs.
export function sheetRunInputs(sheetId: string, userId: string, columns?: readonly string[]): Map<string, RunInputs> {
  const keys = db.prepare('SELECT id, column_name, legacy_set FROM run_input_keys WHERE sheet_id = ? AND user_id = ?')
    .all(sheetId, userId) as KeyRow[];
  const out = new Map<string, RunInputs>();
  if (keys.length === 0) return out;
  const sheetColumns = columns ?? getSheetColumns(sheetId, userId, false);
  for (const k of keys) {
    if (!sheetColumns.includes(k.column_name)) continue;
    const r = keyInputs(k, userId, sheetColumns);
    if (r.sets.length > 0) out.set(k.column_name, r);
  }
  return out;
}

// The out-of-date check of one run column (its main column), or null when no
// run has fingerprinted a row of it: rerun targets and counts select it.
export function columnStaleCheck(sheetId: string, userId: string, main: string): CompiledFilter | null {
  const k = db.prepare(`SELECT id, column_name, legacy_set FROM run_input_keys
    WHERE sheet_id = ? AND user_id = ? AND column_name = ?`).get(sheetId, userId, main) as KeyRow | undefined;
  if (!k) return null;
  const r = keyInputs(k, userId, getSheetColumns(sheetId, userId, false));
  return r.sets.length > 0 ? staleSql(r) : null;
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
