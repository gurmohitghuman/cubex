// A row's input fingerprint (pure): what a run result was made from, kept in
// rows.run_inputs (migration 039) and compared with the row's cells now to tell
// an out-of-date result. Both sides read the cells through SQLite: a run hands
// the SQL function cubex_run_fp the json_extract of the row text it read, a
// reader the json_extract of the row as it is, so the two agree on every value
// (numbers, nested JSON) by construction. Registered on every connection
// (lib/db.ts, worker threads too); never used in the schema (trusted_schema is
// off). A cell holding Cubex's own words (⏳ ❌ ⏭️ ➕) reads as empty, as runs
// read their inputs.
import type { Database } from 'better-sqlite3';
import { holdsRunMarker } from '../run-markers';

// A value as json_extract gives it: text, a number, or NULL for a missing cell.
function inputText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return holdsRunMarker(v) ? '' : v;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return '';
}

// 53 bits from two 32-bit multiply-xor lanes: a changed input reads the same
// with odds of about 1 in 9e15, and a million rows hash in well under a second.
// Undoing a run prints cells with it too (lib/run-undo/print.ts).
export function hash53(s: string): number {
  let a = 0x9e3779b9;
  let b = 0x85ebca6b;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x9e3779b1);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  a = Math.imul(a ^ (a >>> 16), 0x85ebca6b) ^ Math.imul(b ^ (b >>> 13), 0xc2b2ae35);
  b = Math.imul(b ^ (b >>> 16), 0x85ebca6b) ^ Math.imul(a ^ (a >>> 13), 0xc2b2ae35);
  return (b & 0x1fffff) * 0x100000000 + (a >>> 0);
}

// The input values in the run's order, each length-prefixed so ("ab", "c")
// and ("a", "bc") differ. The count leads: a setup that reads one more column
// makes a different fingerprint even when that column is empty.
export function runInputFingerprint(values: readonly unknown[]): string {
  const parts = values.map(inputText);
  return hash53(`${parts.length}|${parts.map(p => `${p.length}:${p}`).join('|')}`).toString(36);
}

// What a setup reading no column at all is made from: never out of date.
export const NO_INPUTS_FINGERPRINT = runInputFingerprint([]);

export function registerRunInputFunctions(db: Database): void {
  db.function('cubex_run_fp', { deterministic: true, varargs: true },
    (...values: unknown[]) => runInputFingerprint(values));
}
