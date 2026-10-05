// Sheet-tab create/rename/delete/reorder — extracted verbatim from
// routes/api-v1-table-sheets.ts so the /v1 routes and the MCP manage_sheet
// tool share one implementation, on top of the same lib/sheet-crud-helpers
// txns the UI uses. Invariants preserved: table-scoped ownership, name
// conflicts, last-sheet delete guard, run abort + webhook-source capture INSIDE
// the delete txn, bucket drop after commit. (No sheets-per-table cap.)
import { db } from '../lib/db';
import { validateSheetName } from '../lib/sheet-validation';
import { abortRunsForSheets } from './run-control';
import { dropBucketsForSheets } from '../lib/webhook-bucket';
import { sheetBusyWith, busyMessage } from '../lib/sheet-busy';
import {
  verifyTableOwnership, verifySheetInTable, listSheets, sheetNameTaken, createSheetTxn,
} from '../lib/sheet-crud-helpers';
import { TableCrudFail } from './table-crud';
import { normalizeNameSpacing } from '../lib/name-safety';

type Fail = TableCrudFail;
export type SheetCrudOutcome = { ok: { sheet?: unknown; sheets: unknown[] } } | Fail;

export function createSheet(
  userId: string, tableId: string, rawName: unknown, afterSheetId: string | undefined,
): SheetCrudOutcome {
  if (!verifyTableOwnership(tableId, userId)) return { fail: 'not_found', message: 'Table not found' };
  let trimmedName: string | undefined;
  if (rawName !== undefined) {
    const err = validateSheetName(rawName);
    if (err) return { fail: 'bad_request', message: err };
    trimmedName = normalizeNameSpacing(rawName as string);
  }

  // API/MCP-created sheets start truly empty (0 columns, 0 rows): agents add
  // their own schema; the UI scaffold would just be renamed/deleted anyway.
  const result = createSheetTxn(tableId, userId, trimmedName, afterSheetId, { seed: false });
  if (!result.ok) {
    return { fail: 'conflict', message: `A sheet named "${trimmedName}" already exists in this table` };
  }
  const sheet = db.prepare('SELECT id, name, position FROM sheets WHERE id = ?').get(result.sheetId);
  return { ok: { sheet, sheets: listSheets(tableId, userId) } };
}

export function renameSheet(
  userId: string, tableId: string, sheetId: string, rawName: unknown,
): SheetCrudOutcome {
  if (!verifyTableOwnership(tableId, userId)) return { fail: 'not_found', message: 'Table not found' };
  const err = validateSheetName(rawName);
  if (err) return { fail: 'bad_request', message: err };
  const name = normalizeNameSpacing(rawName as string);

  let fail: Fail | null = null;
  db.transaction(() => {
    if (!verifySheetInTable(sheetId, tableId, userId)) {
      fail = { fail: 'not_found', message: 'Sheet not found' };
      return;
    }
    if (sheetNameTaken(tableId, userId, name, sheetId)) {
      fail = { fail: 'conflict', message: `A sheet named "${name}" already exists in this table` };
      return;
    }
    db.prepare("UPDATE sheets SET name = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
      .run(name, sheetId, userId);
  }).immediate();
  if (fail) return fail;
  return { ok: { sheet: { id: sheetId, name }, sheets: listSheets(tableId, userId) } };
}

// Last-sheet guard + run abort + webhook-source capture INSIDE the txn (a
// delete losing the last-sheet race must never cancel runs on a surviving
// sheet); bucket drop after commit.
export function deleteSheet(userId: string, tableId: string, sheetId: string): SheetCrudOutcome {
  if (!verifyTableOwnership(tableId, userId)) return { fail: 'not_found', message: 'Table not found' };
  if (!verifySheetInTable(sheetId, tableId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  const busy = sheetBusyWith(sheetId);
  if (busy) return { fail: 'conflict', message: busyMessage(busy) };

  let isLastSheet = false;
  let sourceIds: string[] = [];
  db.transaction(() => {
    const { c } = db.prepare('SELECT COUNT(*) AS c FROM sheets WHERE table_id = ? AND user_id = ?')
      .get(tableId, userId) as { c: number };
    if (c <= 1) { isLastSheet = true; return; }
    sourceIds = (db.prepare('SELECT id FROM webhook_sources WHERE sheet_id = ? AND user_id = ?')
      .all(sheetId, userId) as Array<{ id: string }>).map(r => r.id);
    abortRunsForSheets([sheetId]);
    db.prepare('DELETE FROM sheets WHERE id = ? AND user_id = ?').run(sheetId, userId);
  }).immediate();
  if (isLastSheet) return { fail: 'bad_request', message: 'A table must have at least one sheet.' };
  dropBucketsForSheets(sourceIds);
  return { ok: { sheets: listSheets(tableId, userId) } };
}

export function reorderSheets(
  userId: string, tableId: string, orderedSheetIds: string[],
): SheetCrudOutcome {
  if (!verifyTableOwnership(tableId, userId)) return { fail: 'not_found', message: 'Table not found' };

  let bad = false;
  db.transaction(() => {
    const current = (db.prepare('SELECT id FROM sheets WHERE table_id = ? AND user_id = ?')
      .all(tableId, userId) as Array<{ id: string }>).map(r => r.id);
    const a = [...current].sort();
    const b = [...orderedSheetIds].sort();
    if (a.length !== b.length || a.some((id, i) => id !== b[i])) { bad = true; return; }
    const setPos = db.prepare('UPDATE sheets SET position = ? WHERE id = ? AND user_id = ?');
    orderedSheetIds.forEach((id, i) => setPos.run(i, id, userId));
  }).immediate();
  if (bad) return { fail: 'bad_request', message: "ordered_sheet_ids must match the table's sheets exactly" };
  return { ok: { sheets: listSheets(tableId, userId) } };
}
