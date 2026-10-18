// Out of date, as SQL over a `rows` row (pure). A run column's inputs (the
// columns its newest run reads, lib/run-inputs/columns.ts) under its key in
// rows.run_inputs (lib/run-inputs/keys.ts): the row's result is out of date
// when the fingerprint its run wrote differs from the one its cells make now.
// A row no run has fingerprinted (filled before migration 039, kept out by a
// rule, restored from the trash) never is. Callers AND it with the cell's run
// state: only a row holding a result (done, or done without one such as
// "⏭️ Not found") can be out of date.
import { jsonPath } from '../json-path';
import { NO_INPUTS_FINGERPRINT } from './fingerprint';
import type { RunInputList } from './columns';

export interface RunInputs {
  key: number;                  // run_input_keys.id of the column's main column
  inputs: Readonly<RunInputList>; // what its newest run reads, in its order (null: a gone column, read empty)
}

// A key's place in rows.run_inputs.
export const runInputPath = (key: number): string => `$."${key}"`;

// A run's inputs as cubex_run_fp's arguments over `source` (a JSON text): each
// column's cell, NULL for a gone one. Shared with the stamp, so both read alike.
export function fingerprintArgs(
  inputs: Readonly<RunInputList>, source: string,
): { sql: string; params: string[] } {
  return {
    sql: inputs.map(c => (c === null ? 'NULL' : `json_extract(${source}, ?)`)).join(', '),
    params: inputs.filter((c): c is string => c !== null).map(jsonPath),
  };
}

// The current fingerprint of a row's inputs, in SQL over its `data`.
function currentFingerprint(inputs: Readonly<RunInputList>): { sql: string; params: unknown[] } {
  if (inputs.length === 0) return { sql: '?', params: [NO_INPUTS_FINGERPRINT] };
  const args = fingerprintArgs(inputs, 'data');
  return { sql: `cubex_run_fp(${args.sql})`, params: args.params };
}

// True when the row's stored fingerprint differs from its cells now. A row
// without one reads NULL, never true. Over the rows table's own column names.
export function staleSql(r: RunInputs): { sql: string; params: unknown[] } {
  const now = currentFingerprint(r.inputs);
  return {
    sql: `(run_inputs IS NOT NULL AND json_extract(run_inputs, ?) <> ${now.sql})`,
    params: [runInputPath(r.key), ...now.params],
  };
}
