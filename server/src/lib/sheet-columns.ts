import { db } from './db';

// The column registry: column_order is the column registry. A
// sheet's columns are exactly the names in sheets.column_order, in display
// order. Rows only hold values: a row without a key has an empty cell there, so
// an empty column is still a column (as in any spreadsheet) and reading the
// column list never scans rows, which is what keeps a million-row sheet fast.
// Every column-creating site appends via appendColumnsToOrder in the same
// transaction as its row writes; lib/column-repair.ts is the background safety
// net for one that doesn't.

// Distinct column names across all rows of a sheet, in the order they first
// appear (the lowest row_index holding the key). A full json_each scan, so it is
// only for seeding a sheet that has no column_order yet.
export function listColumnsInInsertionOrder(sheetId: string, userId: string): string[] {
  const rows = db.prepare(`
    SELECT key, MIN(row_index) AS first_row, MIN(je.rowid) AS first_seen
    FROM rows r, json_each(r.data) je
    WHERE r.sheet_id = ? AND r.user_id = ?
    GROUP BY key
    ORDER BY first_row ASC, first_seen ASC
  `).all(sheetId, userId) as Array<{ key: string; first_row: number; first_seen: number }>;
  return rows.map(r => r.key);
}

// The stored list, minus anything that isn't a name or repeats one (a column
// listed twice would show twice); null when there is no usable list.
function parseOrder(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return [...new Set(parsed.filter((c): c is string => typeof c === 'string'))];
  } catch {
    return null;
  }
}

// The sheet's columns in display order ([] for an unknown sheet). A sheet with
// no usable column_order (no column added yet, or a pre-registry sheet) is
// seeded from its rows once and saved; persist=false skips the save for callers
// that must not write.
export function getSheetColumns(sheetId: string, userId: string, persist = true): string[] {
  const sheet = db.prepare(
    'SELECT column_order FROM sheets WHERE id = ? AND user_id = ?',
  ).get(sheetId, userId) as { column_order: string | null } | undefined;
  if (!sheet) return [];
  const order = parseOrder(sheet.column_order);
  if (order) return order;
  const seeded = listColumnsInInsertionOrder(sheetId, userId);
  if (persist) {
    db.prepare('UPDATE sheets SET column_order = ? WHERE id = ? AND user_id = ?')
      .run(JSON.stringify(seeded), sheetId, userId);
  }
  return seeded;
}

// Append one or more new columns to a sheet's column_order, preserving existing
// order and skipping duplicates (a sheet without an order is seeded first, as in
// getSheetColumns). Call this in any code path that creates a new column, inside
// the same transaction as the row INSERTs/UPDATEs that fill it.
export function appendColumnsToOrder(sheetId: string, userId: string, newColumns: string[]): void {
  if (newColumns.length === 0) return;
  const sheet = db.prepare(
    'SELECT column_order FROM sheets WHERE id = ? AND user_id = ?',
  ).get(sheetId, userId) as { column_order: string | null } | undefined;
  if (!sheet) return;

  const nextOrder = parseOrder(sheet.column_order) ?? listColumnsInInsertionOrder(sheetId, userId);
  const seen = new Set(nextOrder);
  for (const col of newColumns) {
    if (!seen.has(col)) { nextOrder.push(col); seen.add(col); }
  }

  db.prepare(
    "UPDATE sheets SET column_order = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
  ).run(JSON.stringify(nextOrder), sheetId, userId);
}
