import { v4 as uuidv4 } from 'uuid';
import { db } from './db';
import { appendColumnsToOrder } from './sql-helpers';

// The default column name a brand-new empty sheet ships with.
export const SEED_COLUMN_NAME = 'Column 1';
// How many blank rows a new sheet seeds. Enough that the grid renders a usable
// strip instead of the import-only empty state (a 0-row sheet hits SheetEmptyState).
export const SEED_ROW_COUNT = 3;

// Seed a freshly-created sheet with one column + a few blank rows so it opens as a
// usable empty grid (Google Sheets behaviour), NOT a dead-end import prompt.
//
// CRITICAL: the seed column must live in real rows.data, not just column_order.
// getSheetColumns() verifies column_order against the keys that actually exist in
// rows.data and DROPS any column no row has ("ghost" pruning). So we INSERT rows
// whose data contains the column key, THEN appendColumnsToOrder — or the column
// would vanish on first read.
//
// MUST be called inside the SAME transaction as the sheet INSERT (it reads the
// sheet row via appendColumnsToOrder).
export function seedEmptySheet(sheetId: string, userId: string): void {
  const blank = JSON.stringify({ [SEED_COLUMN_NAME]: '' });
  const insertRow = db.prepare(
    `INSERT INTO rows (id, sheet_id, user_id, row_index, data, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
  );
  for (let i = 0; i < SEED_ROW_COUNT; i++) {
    insertRow.run(uuidv4(), sheetId, userId, i, blank);
  }
  appendColumnsToOrder(sheetId, userId, [SEED_COLUMN_NAME]);
}
