// Sheet-tab create/rename/delete/reorder: one implementation for the app
// (routes/tables-sheets.ts), the /v1 routes and the MCP manage_sheet tool, on
// top of the lib/sheet-crud-helpers txns. Invariants: table-scoped ownership,
// name conflicts among live sheets, the last-sheet delete guard; a delete
// puts the sheet in the trash whole (services/trash-sheets.ts). (No
// sheets-per-table cap.)
import { db } from '../lib/db';
import { validateSheetName } from '../lib/sheet-validation';
import type { ResultsNotAdded } from './enrich-list-guard';
import { trashSheet } from './trash-sheets';
import {
  verifyTableOwnership, verifySheetInTable, listSheets, sheetNameTaken, createSheetTxn,
} from '../lib/sheet-crud-helpers';
import { TableCrudFail } from './table-crud';
import { normalizeNameSpacing } from '../lib/name-safety';
import { logSheetChange } from '../lib/change-log';

type Fail = TableCrudFail;
export type SheetCrudOutcome =
  | { ok: { sheet?: unknown; sheets: unknown[]; notAdded?: ResultsNotAdded; trashId?: number | null } }
  | Fail;

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
    const old = db.prepare('SELECT name FROM sheets WHERE id = ?').pluck().get(sheetId) as string;
    db.prepare("UPDATE sheets SET name = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
      .run(name, sheetId, userId);
    if (old !== name) {
      logSheetChange(sheetId, userId, 'sheet_renamed', `Renamed the sheet "${old}" to "${name}"`,
        { detail: { from: old, to: name } });
    }
  }).immediate();
  if (fail) return fail;
  return { ok: { sheet: { id: sheetId, name }, sheets: listSheets(tableId, userId) } };
}

// Into the trash, whole (services/trash-sheets.ts): the last-sheet guard, the
// runs stopped and the sheet hidden in one transaction.
export function deleteSheet(userId: string, tableId: string, sheetId: string): SheetCrudOutcome {
  if (!verifyTableOwnership(tableId, userId)) return { fail: 'not_found', message: 'Table not found' };
  const out = trashSheet(userId, tableId, sheetId);
  if ('fail' in out) return out;
  return {
    ok: { sheets: listSheets(tableId, userId), trashId: out.ok.trashId,
      ...(out.ok.notAdded ? { notAdded: out.ok.notAdded } : {}) },
  };
}

export function reorderSheets(
  userId: string, tableId: string, orderedSheetIds: string[],
): SheetCrudOutcome {
  if (!verifyTableOwnership(tableId, userId)) return { fail: 'not_found', message: 'Table not found' };

  let bad = false;
  db.transaction(() => {
    const current = (db.prepare('SELECT id FROM sheets WHERE table_id = ? AND user_id = ? AND trash_id IS NULL')
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
