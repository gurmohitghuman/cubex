// Row write flows — extracted from routes/api-v1-rows.ts so the /v1 routes and
// the MCP tools share one implementation. Semantics:
// UPDATE-ONLY columns, stable-row-id addressing, run-locked 409s, data_version
// bump inside every transaction, result purge on delete.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { countRows, jsonPath, parseRowData, purgeResultsForRows } from '../lib/sql-helpers';
import { MAX_ROWS_PER_SHEET } from '../lib/constants';
import { bumpDataVersion, sheetHasActiveRun, checkColumns, TxnFail } from './data-plane-shared';
import { busyMessage, nextRowIndex, sheetBusyWith } from '../lib/sheet-busy';

export type AppendOutcome =
  | { ok: { rows: Array<{ id: string; index: number }> } }
  | TxnFail;

// ONE immediate txn: MAX(row_index)+1 and all N inserts are atomic vs
// concurrent webhook/UI adds. Caller has validated cell maps + batch size.
export function appendRows(
  sheetId: string, userId: string, parsedRows: Array<Record<string, string>>,
): AppendOutcome {
  const incomingCols = new Set<string>();
  for (const cells of parsedRows) for (const c of Object.keys(cells)) incomingCols.add(c);

  let fail: TxnFail | null = null;
  const created: Array<{ id: string; index: number }> = [];
  db.transaction(() => {
    fail = checkColumns(sheetId, userId, incomingCols);
    if (fail) return;
    const current = countRows(sheetId, userId);
    if (current + parsedRows.length > MAX_ROWS_PER_SHEET) {
      fail = { fail: 'cap', remaining: Math.max(0, MAX_ROWS_PER_SHEET - current) };
      return;
    }
    let next = nextRowIndex(sheetId, userId);
    const insert = db.prepare(
      'INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, ?, ?)',
    );
    for (const cells of parsedRows) {
      const id = uuidv4();
      insert.run(id, sheetId, userId, next, JSON.stringify(cells));
      created.push({ id, index: next });
      next++;
    }
    bumpDataVersion(sheetId, userId);
  }).immediate();

  if (fail) return fail;
  return { ok: { rows: created } };
}

export type PatchOutcome =
  | { ok: { id: string; index: number; data: Record<string, string> } }
  | TxnFail;

// Update cells on ONE row by stable id. Lookup, writes, bump, and the fresh
// read all live in ONE immediate txn (a concurrent delete between an
// outside-txn lookup and the writes would phantom-bump data_version).
export function patchRowById(
  rowId: string, userId: string, cells: Record<string, string>,
): PatchOutcome {
  let fail: TxnFail | null = null;
  let result: { id: string; index: number; data: string } | null = null;
  db.transaction(() => {
    const row = db.prepare(
      'SELECT id, sheet_id, row_index FROM rows WHERE id = ? AND user_id = ?',
    ).get(rowId, userId) as { id: string; sheet_id: string; row_index: number } | undefined;
    if (!row) { fail = { fail: 'not_found' }; return; }
    // Addressed by row id, so outside the sheet routes' busy gate: a sort, an
    // import or a column rewrite in progress (lib/sheet-busy.ts) is checked here.
    const busy = sheetBusyWith(row.sheet_id);
    if (busy) { fail = { fail: 'busy', message: busyMessage(busy) }; return; }
    fail = checkColumns(row.sheet_id, userId, new Set(Object.keys(cells)));
    if (fail) return;
    const set = db.prepare(
      "UPDATE rows SET data = json_set(data, ?, ?), updated_at = datetime('now') WHERE id = ? AND user_id = ?",
    );
    for (const [col, val] of Object.entries(cells)) set.run(jsonPath(col), val, row.id, userId);
    bumpDataVersion(row.sheet_id, userId);
    const fresh = db.prepare('SELECT data FROM rows WHERE id = ? AND user_id = ?')
      .get(row.id, userId) as { data: string };
    result = { id: row.id, index: row.row_index, data: fresh.data };
  }).immediate();
  if (fail) return fail;
  const done = result as unknown as { id: string; index: number; data: string };
  return { ok: { id: done.id, index: done.index, data: parseRowData(done.data) } };
}

export type DeleteRowsOutcome = { ok: { deleted: number } } | TxnFail;

// Bulk delete by stable row ids: resolve ids → owned row_indices INSIDE the
// txn, sheet-wide active-run guard, purge per-row AI/HTTP results for those
// indices, bump data_version. No rowGeneration echo — ids are generation-immune.
export function deleteRowsByIds(
  sheetId: string, userId: string, rowIds: string[],
): DeleteRowsOutcome {
  const unique = Array.from(new Set(rowIds));
  let fail: TxnFail | null = null;
  let deleted = 0;
  db.transaction(() => {
    if (sheetHasActiveRun(sheetId, userId)) { fail = { fail: 'active_run' }; return; }
    const ph = unique.map(() => '?').join(',');
    const found = db.prepare(
      `SELECT id, row_index FROM rows WHERE sheet_id = ? AND user_id = ? AND id IN (${ph})`,
    ).all(sheetId, userId, ...unique) as Array<{ id: string; row_index: number }>;
    if (found.length === 0) return;
    db.prepare(
      `DELETE FROM rows WHERE sheet_id = ? AND user_id = ? AND id IN (${found.map(() => '?').join(',')})`,
    ).run(sheetId, userId, ...found.map(r => r.id));
    deleted = found.length;
    purgeResultsForRows(sheetId, userId, found.map(r => r.row_index));
    bumpDataVersion(sheetId, userId);
  }).immediate();
  if (fail) return fail;
  return { ok: { deleted } };
}
