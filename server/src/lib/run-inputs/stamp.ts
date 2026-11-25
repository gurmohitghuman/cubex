// Writing what a row's result was made from (migration 039). A run makes one
// stamper when it starts (its main column's key, the columns it reads), and
// each row it reads (lib/run-rows.ts) gets a stamp of the row text as read: a
// cell edited while the row's call is out leaves the stamp of the old value,
// so the row reads as out of date afterwards, as it should. The writers put
// the stamp in the same UPDATE as the row's result (lib/run-cells-write.ts).
// The stamp names the list of columns it was made from (lib/run-inputs/sets.ts),
// so a reader checks the row against those, whatever the column's setup reads later.
import { db } from '../db';
import { ensureRunInputKey } from './keys';
import { ensureRunInputSet, stampText } from './sets';
import { fingerprintArgs, runInputPath } from './stale-sql';
import { NO_INPUTS_FINGERPRINT } from './fingerprint';
import type { RunInputList } from './columns';

export interface RowStamp { path: string; fp: string }
export interface RunInputStamper { stamp(rawRowData: string): RowStamp }

// main: the run's main column (the key's name); inputs: the columns it reads
// (lib/run-inputs/columns.ts). The fingerprint goes through cubex_run_fp over
// json_extract, exactly as a reader computes it from the row as it is now.
export function runInputStamper(
  sheetId: string, userId: string, main: string, inputs: Readonly<RunInputList>,
): RunInputStamper {
  const key = ensureRunInputKey(sheetId, userId, main);
  const path = runInputPath(key);
  const setId = ensureRunInputSet(key, userId, inputs);
  if (inputs.length === 0) return { stamp: () => ({ path, fp: stampText(setId, NO_INPUTS_FINGERPRINT) }) };
  const args = fingerprintArgs(inputs, 'r.d');
  const read = db.prepare(`WITH r(d) AS (SELECT ?) SELECT cubex_run_fp(${args.sql}) FROM r`).pluck();
  const paths = args.params;
  return {
    stamp: raw => {
      // A row whose text isn't JSON (never written so) reads every input as empty.
      let fp: string;
      try { fp = read.get(raw, ...paths) as string; } catch { fp = read.get('{}', ...paths) as string; }
      return { path, fp: stampText(setId, fp) };
    },
  };
}
