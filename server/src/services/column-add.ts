// Column add — one implementation for the UI route, /api/v1, and the MCP
// tool. Invariants: sanitize + relaxed validation, exact/case/token collision
// rejection, the column cap, a placeholder row 0 on an empty sheet,
// appendColumnsToOrder in the SAME transaction.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import { appendColumnsToOrder, getSheetColumns, touchSheet } from '../lib/sql-helpers';
import {
  sanitizeAndValidateColumnName, findColumnNameCollision, columnCollisionMessage,
} from '../lib/column-names';

export type ColumnAddOutcome =
  | { ok: true; name: string }
  | { fail: 'invalid'; error: string }
  | { fail: 'collision'; error: string }
  | { fail: 'cap'; error: string };

// Caller has already verified sheet ownership. opts.bumpDataVersion: the
// programmatic surfaces signal open tabs; the UI route keeps touch-only.
export function addSheetColumn(
  sheetId: string,
  userId: string,
  rawName: string,
  // seedEmptyRow (default true): the web app gets row 0 on an empty sheet, a cell
  // to type into. API/MCP pass false: an agent's sheet starts truly empty, and the
  // blank row used to tag along into appends, imports, runs and exports.
  opts: { bumpDataVersion?: boolean; seedEmptyRow?: boolean } = {},
): ColumnAddOutcome {
  const v = sanitizeAndValidateColumnName(rawName);
  if ('error' in v) return { fail: 'invalid', error: v.error };
  const columnName = v.name;

  const existingCols = getSheetColumns(sheetId, userId);
  const collision = findColumnNameCollision(columnName, existingCols);
  if (collision) return { fail: 'collision', error: columnCollisionMessage(columnName, collision) };
  if (existingCols.length >= MAX_COLUMNS_PER_SHEET) {
    return {
      fail: 'cap',
      error: `Column limit reached (${MAX_COLUMNS_PER_SHEET} per sheet). Delete unused columns to add new ones.`,
    };
  }

  db.transaction(() => {
    // Listing the column is what creates it (lib/sheet-columns.ts): no row is
    // touched, so this costs the same at a million rows as at ten. An empty
    // sheet still gets row 0, so there is a cell to type into.
    const hasRow = db.prepare('SELECT 1 FROM rows WHERE sheet_id = ? AND user_id = ? LIMIT 1').get(sheetId, userId);
    if (!hasRow && opts.seedEmptyRow !== false) {
      db.prepare("INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, 0, '{}')")
        .run(uuidv4(), sheetId, userId);
    }
    appendColumnsToOrder(sheetId, userId, [columnName]);
    if (opts.bumpDataVersion) {
      db.prepare(
        `UPDATE sheets SET data_version = data_version + 1, updated_at = datetime('now') WHERE id = ? AND user_id = ?`,
      ).run(sheetId, userId);
    } else {
      touchSheet(sheetId, userId);
    }
  }).immediate();

  return { ok: true, name: columnName };
}
