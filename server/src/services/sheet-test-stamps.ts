// What a test's rows were made from (rows.run_inputs, lib/run-inputs): a stamp is "<list id>:<fingerprint>", the
// list (run_input_sets, migration 066) naming the columns its run read under its column's key, which is the
// sheet's own. Copying a row into a test copy (sheet-test-rows.ts) makes the same list under the copy's key, so
// out of date reads there as on the sheet; applying (sheet-test-results.ts) puts a sample answer back only when
// the copy's stamp and the sheet's new one read the same columns to the same fingerprint.
import { db } from '../lib/db';
import { runInputKey } from '../lib/run-inputs/keys';
import { ensureRunInputSet, runInputSet, stampText } from '../lib/run-inputs/sets';

// A stamp's list id and fingerprint; a stamp written before migration 066 has no id (its key's legacy_set).
export function stampParts(text: string): { set: number | null; fp: string } {
  const at = text.indexOf(':');
  return at < 0 ? { set: null, fp: text } : { set: Number(text.slice(0, at)), fp: text.slice(at + 1) };
}

const legacySet = (key: number): number | null =>
  (db.prepare('SELECT legacy_set FROM run_input_keys WHERE id = ?').pluck().get(key) as number | null) ?? null;

// The stamps of a sheet's row under the copy's keys (keys: the sheet's key to the copy's), each list made there
// too. made: the lists already made, by the sheet's key and list. In the caller's transaction.
export function copiedStamps(
  userId: string, raw: string | null, keys: Map<string, string>, made: Map<string, number | null>,
): string | null {
  if (!raw) return null;
  let stamps: Record<string, unknown>;
  try { stamps = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  const out: Record<string, string> = {};
  for (const [key, text] of Object.entries(stamps ?? {})) {
    const mine = keys.get(key);
    if (!mine || typeof text !== 'string') continue;
    const { set, fp } = stampParts(text);
    const from = set ?? legacySet(Number(key));
    // An old stamp whose key keeps no list never reads out of date: so it stays, as it was.
    if (from === null) { out[mine] = text; continue; }
    const at = `${key}:${from}`;
    if (!made.has(at)) {
      const columns = runInputSet(from, Number(key), userId);
      made.set(at, columns ? ensureRunInputSet(Number(mine), userId, columns) : null);
    }
    const list = made.get(at);
    if (list !== null && list !== undefined) out[mine] = stampText(list, fp);
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

// Whether a copy row's stamp of a column and the sheet's new stamp of it say the same: the same columns read
// (each list under its own sheet's key) to the same fingerprint.
export function sameInputs(
  t: { user_id: string; sheet_id: string; test_sheet_id: string }, column: string, copyStamp: string | null,
  sheetStamp: string,
): boolean {
  if (!copyStamp) return false;
  const a = stampParts(copyStamp), b = stampParts(sheetStamp);
  if (a.fp !== b.fp || a.set === null || b.set === null) return false;
  const copyKey = runInputKey(t.test_sheet_id, t.user_id, column);
  const sheetKey = runInputKey(t.sheet_id, t.user_id, column);
  if (copyKey === null || sheetKey === null) return false;
  const read = runInputSet(a.set, copyKey, t.user_id), reads = runInputSet(b.set, sheetKey, t.user_id);
  return !!read && !!reads && JSON.stringify(read) === JSON.stringify(reads);
}
