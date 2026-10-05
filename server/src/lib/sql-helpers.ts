import { db } from './db';
import { getSheetColumns } from './sheet-columns';

// Re-exported from sql-rows for backwards compatibility with existing callers.
export {
  jsonPath, sanitizeColumnName, parseRowData, buildRowsMapFromRows,
  upsertCellsBatch, purgeResultsForRows,
} from './sql-rows';
export { clearProcessingPlaceholders, seedProcessingPlaceholders } from './placeholder-cells';
export type { RowDB } from './sql-rows';
// Re-exported from sheet-columns (the column_order registry) likewise.
export {
  listColumnsInInsertionOrder, getSheetColumns, appendColumnsToOrder,
} from './sheet-columns';

// Returns the sheet row if the user owns it, null otherwise.
// Use in routes: `if (!verifySheetOwnership(...)) return res.status(404).json(...)`
export function verifySheetOwnership(sheetId: string, userId: string): { id: string } | null {
  const sheet = db.prepare(
    'SELECT id FROM sheets WHERE id = ? AND user_id = ?',
  ).get(sheetId, userId) as { id: string } | undefined;
  return sheet || null;
}

// Touch the updated_at timestamp on a sheet (one-line shortcut).
export function touchSheet(sheetId: string, userId: string): void {
  db.prepare(
    "UPDATE sheets SET updated_at = datetime('now') WHERE id = ? AND user_id = ?",
  ).run(sheetId, userId);
}

// Sort comparator for spreadsheet cells. Matches Google Sheets / Excel
// behavior, per their published sort rules:
//   - Empty/blank cells ALWAYS sort last (both asc and desc) — empties never
//     bubble to the top on Z-A.
//   - Among non-empty values: purely numeric < text (in asc). On desc, text
//     comes before numbers, but empties stay last.
//   - Within the text bucket, use the Alphanum / natural-sort rule via
//     Intl.Collator({numeric:true}) so "row 2" precedes "row 10". This is the
//     standard JS implementation of Dave Koelle's Alphanum algorithm —
//     same logic Finder, File Explorer, and Google Sheets use.
//
// Why strict-numeric instead of parseFloat? parseFloat("42 Main St") returns
// 42, which would mis-sort addresses as numbers. The Alphanum collator
// handles strings-containing-numbers; the strict regex picks out
// pure-numeric cells so they cluster together.
//
// Why a module-scoped Collator? Constructing one per comparison allocates a
// fresh options object every call — slow on 50k-row sorts. A shared instance
// is the documented MDN pattern.
export const STRICT_NUMERIC = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
export const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function compareSortValues(
  aVal: string, bVal: string, direction: 'asc' | 'desc' = 'asc',
): number {
  // Treat whitespace-only as blank to match Google Sheets — "   " in a cell
  // is functionally empty for the user.
  const aEmpty = aVal === '' || aVal.trim() === '';
  const bEmpty = bVal === '' || bVal.trim() === '';
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  const aIsNum = STRICT_NUMERIC.test(aVal.trim());
  const bIsNum = STRICT_NUMERIC.test(bVal.trim());
  let cmp: number;
  if (aIsNum && bIsNum) {
    const an = parseFloat(aVal);
    const bn = parseFloat(bVal);
    cmp = an === bn ? 0 : an < bn ? -1 : 1;
  } else if (aIsNum) {
    cmp = -1;
  } else if (bIsNum) {
    cmp = 1;
  } else {
    cmp = naturalCollator.compare(aVal, bVal);
  }
  return direction === 'desc' ? -cmp : cmp;
}

// Row count for a sheet: indexed COUNT(*), ~tens of ms even at 50k rows.
export function countRows(sheetId: string, userId: string): number {
  return (db.prepare(
    'SELECT COUNT(*) AS c FROM rows WHERE sheet_id = ? AND user_id = ?',
  ).get(sheetId, userId) as { c: number }).c;
}

// Current column count + row count for a sheet. Used to enforce per-sheet capacity caps
// before any path that creates columns or rows. Column count comes from
// getSheetColumns (column_order-first, no scan); row count is the indexed COUNT(*).
export function countColumnsAndRows(sheetId: string, userId: string): { columns: number; rows: number } {
  return {
    columns: getSheetColumns(sheetId, userId).length,
    rows: countRows(sheetId, userId),
  };
}
