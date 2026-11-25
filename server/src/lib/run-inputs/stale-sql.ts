// Out of date, as SQL over a `rows` row (pure). A run column's key in
// rows.run_inputs (lib/run-inputs/keys.ts) holds the stamp its run wrote with
// the row's result: the list it read (lib/run-inputs/sets.ts) and the
// fingerprint of those cells then. The result is out of date when those same
// cells make another fingerprint now; what the column's setup reads since
// doesn't count (a setup change never marks rows out of date). A row no run has
// fingerprinted (filled before migration 039, kept out by a rule, restored from
// the trash), or made from a list too old to read, never is. Callers AND it
// with the cell's run state: only a row holding a result (done, or done
// without one such as "⏭️ Not found") can be out of date.
import { jsonPath } from '../json-path';
import { NO_INPUTS_FINGERPRINT } from './fingerprint';
import type { RunInputList } from './columns';

// One input list as a reader checks it: id null for stamps written before
// migration 066 (no list named), checked against `inputs` as they were then.
export interface RunInputSet {
  id: number | null;
  inputs: Readonly<RunInputList>; // the columns in the run's order (null: a gone column, read empty)
}

export interface RunInputs {
  key: number;                    // run_input_keys.id of the column's main column
  sets: readonly RunInputSet[];   // the lists its stamps name, newest first
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

// True when the row's stamp differs from the one its own list's cells make
// now; NULL (never true) for a row without one or with a list not in `sets`.
// The stamp's list is the text up to ':' ('' before migration 066), so each
// row computes one fingerprint. The stamp is read once, in a scalar subquery
// (1M rows counted: about +10% over
// one fingerprint against one list, +26% with 16 lists spread evenly; reading
// it three times cost +21% and +49%). Over the rows table's own column names.
export function staleSql(r: RunInputs): { sql: string; params: unknown[] } {
  if (r.sets.length === 0) return { sql: 'NULL', params: [] };
  const whens: string[] = [];
  const params: unknown[] = [];
  for (const set of r.sets) {
    const now = currentFingerprint(set.inputs);
    // A literal (an integer id this code made), as a bound value it compares slower.
    if (set.id !== null && !Number.isSafeInteger(set.id)) continue;
    const prefix = set.id === null ? "''" : `'${set.id}:'`;
    whens.push(`WHEN ${prefix} THEN s <> ${prefix} || ${now.sql}`);
    params.push(...now.params);
  }
  return {
    sql: `(run_inputs IS NOT NULL AND (SELECT CASE substr(s, 1, instr(s, ':')) ${whens.join(' ')} END
      FROM (SELECT json_extract(run_inputs, ?) AS s)))`,
    params: [...params, runInputPath(r.key)],
  };
}
