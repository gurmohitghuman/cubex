// The rows of a test (services/sheet-test*.ts): which of the sheet's rows to take (the top ones, some at random,
// or those chosen), and copying them into the test copy as they are: values, ❌ and ⏭️ answers, and what each
// result was made from (rows.run_inputs, under the copy's keys), so out of date reads the same there. Each copied
// row is linked to its row in the sheet (sheet_test_rows), where applying puts results back. Reads only the rows
// it takes, never the sheet: the top ones and random ones through the row_index index.
import { db } from '../lib/db';
import { SHEET_TEST_MAX_ROWS } from '../lib/constants';
import { ensureRunInputKey, sheetRunInputKeys } from '../lib/run-inputs/keys';
import { orderedUuid } from '../lib/ordered-id';
import { rowsChanged } from '../lib/rows-changed';
import type { TestRecord } from './sheet-test-store';

type Test = Pick<TestRecord, 'id' | 'user_id' | 'sheet_id' | 'test_sheet_id'>;

export const rowsInTest = (testId: string): Set<string> =>
  new Set(db.prepare('SELECT live_row_id FROM sheet_test_rows WHERE test_id = ?').pluck().all(testId) as string[]);

// The first `n` rows of the sheet in row order that the test doesn't hold yet.
export function topRows(sheetId: string, userId: string, n: number, have: Set<string>): string[] {
  const ids = db.prepare('SELECT id FROM rows WHERE sheet_id = ? AND user_id = ? ORDER BY row_index LIMIT ?').pluck()
    .all(sheetId, userId, n + have.size) as string[];
  return ids.filter(id => !have.has(id)).slice(0, n);
}

// Up to `n` rows picked at random by position, none the test holds yet (a few tries each: a small sheet may
// have fewer left).
export function randomRows(sheetId: string, userId: string, n: number, have: Set<string>): string[] {
  const span = db.prepare(`SELECT MIN(row_index) AS lo, MAX(row_index) AS hi FROM rows
    WHERE sheet_id = ? AND user_id = ?`).get(sheetId, userId) as { lo: number | null; hi: number | null };
  if (span.lo === null || span.hi === null) return [];
  const at = db.prepare(`SELECT id FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index >= ?
    ORDER BY row_index LIMIT 1`).pluck();
  const out: string[] = [];
  const taken = new Set(have);
  for (let tries = 0; out.length < n && tries < n * 8; tries++) {
    const index = span.lo + Math.floor(Math.random() * (span.hi - span.lo + 1));
    const id = at.get(sheetId, userId, index) as string | undefined;
    if (id && !taken.has(id)) { taken.add(id); out.push(id); }
  }
  return out;
}

// The chosen rows that are the sheet's, in the order given, once each.
export function sheetRowsOf(sheetId: string, userId: string, ids: string[]): string[] {
  const found = new Set(db.prepare(`SELECT id FROM rows WHERE id IN (SELECT value FROM json_each(?))
    AND sheet_id = ? AND user_id = ?`).pluck().all(JSON.stringify(ids), sheetId, userId) as string[]);
  return [...new Set(ids)].filter(id => found.has(id));
}

// The rows at these places in the sheet (the app's selection), in the order given, once each.
export function sheetRowsAt(sheetId: string, userId: string, indexes: number[]): string[] {
  const at = new Map((db.prepare(`SELECT row_index, id FROM rows WHERE sheet_id = ? AND user_id = ?
    AND row_index IN (SELECT value FROM json_each(?))`).all(sheetId, userId, JSON.stringify(indexes)) as
    Array<{ row_index: number; id: string }>).map(r => [r.row_index, r.id]));
  return [...new Set(indexes)].flatMap(i => (at.has(i) ? [at.get(i)!] : []));
}

// The sheet's run-input keys mapped to the copy's (made there for the same column names).
function keyMap(t: Test): Map<string, string> {
  const out = new Map<string, string>();
  for (const [column, key] of sheetRunInputKeys(t.sheet_id, t.user_id)) {
    out.set(String(key), String(ensureRunInputKey(t.test_sheet_id, t.user_id, column)));
  }
  return out;
}

function copiedStamps(raw: string | null, keys: Map<string, string>): string | null {
  if (!raw) return null;
  let stamps: Record<string, unknown>;
  try { stamps = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  const out: Record<string, unknown> = {};
  for (const [key, fp] of Object.entries(stamps ?? {})) {
    const mine = keys.get(key);
    if (mine) out[mine] = fp;
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

// Copies the rows (ids in the sheet, in order) to the end of the copy, up to the test's limit. In the caller's
// transaction. Returns how many went in.
export function copyRowsIntoTest(t: Test, liveRowIds: string[]): number {
  const have = rowsInTest(t.id);
  const wanted = [...new Set(liveRowIds)].filter(id => !have.has(id)).slice(0, SHEET_TEST_MAX_ROWS - have.size);
  if (!wanted.length) return 0;
  const rows = new Map((db.prepare(`SELECT id, data, run_inputs FROM rows WHERE id IN (SELECT value FROM json_each(?))
    AND sheet_id = ? AND user_id = ?`).all(JSON.stringify(wanted), t.sheet_id, t.user_id) as
    Array<{ id: string; data: string; run_inputs: string | null }>).map(r => [r.id, r]));
  const keys = keyMap(t);
  let next = (db.prepare('SELECT MAX(row_index) FROM rows WHERE sheet_id = ? AND user_id = ?').pluck()
    .get(t.test_sheet_id, t.user_id) as number | null ?? -1) + 1;
  const insert = db.prepare(`INSERT INTO rows (id, sheet_id, user_id, row_index, data, run_inputs)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const link = db.prepare('INSERT INTO sheet_test_rows (test_id, test_row_id, live_row_id) VALUES (?, ?, ?)');
  let n = 0;
  for (const id of wanted) {
    const row = rows.get(id);
    if (!row) continue;
    const copyId = orderedUuid();
    insert.run(copyId, t.test_sheet_id, t.user_id, next++, row.data, copiedStamps(row.run_inputs, keys));
    link.run(t.id, copyId, id);
    n++;
  }
  rowsChanged(t.test_sheet_id);
  db.prepare(`UPDATE sheets SET data_version = data_version + 1, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?`).run(t.test_sheet_id, t.user_id);
  return n;
}
