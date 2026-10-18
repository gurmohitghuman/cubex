// Row filters on a sheet (lib/row-filter): a `where` checked against the sheet
// and compiled to SQL, and the grid's saved filters as the same SQL. Every
// reader takes them from here: read_rows and REST rows/query (row-selection),
// CSV export (lib/csv-export.ts), transfer_rows, transform_column, the grid's
// reads (routes/sheets-read.ts) and "rows in the current filter" runs
// (enrich-rows-filter.ts). Run-state operators need the sheet's run columns,
// read only when a filter or include_status asks for them.
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { sheetColumnKinds } from '../lib/column-types';
import { fillingColumns } from '../lib/field-fill-columns';
import { isStateOp } from '../lib/row-filter/ops';
import { checkWhere, whereConditions, type WhereItem } from '../lib/row-filter/where';
import { compileWhere, type CompiledFilter } from '../lib/row-filter/sql';
import { viewWhere } from '../lib/views/filters';
import {
  columnFilterCondition, gridWhere, parseColumnFilters, parseEmptyFilter, toColumnFilter, type ColumnFilters,
} from '../lib/row-filter/grid';

// The sheet's run columns (AI, HTTP API, enrichment) still in it → the column
// holding their run's state (the column itself once that one is gone).
export function sheetRunColumns(sheetId: string, userId: string, columns: readonly string[]): Map<string, string> {
  return liveRunColumns(sheetColumnKinds(sheetId, userId).runState, columns);
}

// A state column is always a live run column holding its own state (sql.ts
// relies on it); an output whose status column isn't reads its own cells.
export function liveRunColumns(runState: ReadonlyMap<string, string>, columns: readonly string[]): Map<string, string> {
  const live = new Set(columns);
  const out = new Map<string, string>();
  for (const [column, state] of runState) {
    if (!live.has(column)) continue;
    out.set(column, live.has(state) && runState.get(state) === state ? state : column);
  }
  return out;
}

const readsRunState = (where: readonly WhereItem[]) => whereConditions(where).some(c => isStateOp(c.operator));

export interface PreparedWhere { filter: CompiledFilter; runColumns: Map<string, string> }

// A `where` for one sheet, checked (a message the caller can act on) and
// compiled. `columns`: the sheet's columns when the caller already has them.
// A column still filling from stored answers is half filled, so a filter on it
// would match some rows only by timing: refused until the fill is done.
export function prepareWhere(
  sheetId: string, userId: string, where: readonly WhereItem[], columns?: readonly string[],
): { ok: PreparedWhere } | { error: string } {
  const sheetColumns = columns ?? getSheetColumns(sheetId, userId, false);
  const runColumns = readsRunState(where) ? sheetRunColumns(sheetId, userId, sheetColumns) : new Map<string, string>();
  const invalid = checkWhere(where, { columns: sheetColumns, runColumns });
  if (invalid) return { error: invalid };
  const read = new Set(whereConditions(where).flatMap(c =>
    c.column !== undefined ? [c.column] : isStateOp(c.operator) ? [...runColumns.keys()] : []));
  const filling = fillingColumns(sheetId, userId).find(c => read.has(c));
  if (filling) {
    return { error: `"${filling}" is still filling from stored answers. Filter on it once get_sheet no longer `
      + 'lists it in filling_columns.' };
  }
  return { ok: { filter: compileWhere(where, runColumns), runColumns } };
}

export interface SavedFilters { empty_filter: string | null; column_filters: string | null; row_filter: string | null }

// The grid's saved filters (sheets.empty_filter, column_filters and row_filter:
// the active view's, lib/views/filters.ts) as one SQL condition, or null when
// the sheet has none. `runColumns`: when the
// caller already has them (the grid's read does).
export function savedFilterSql(
  sheetId: string, userId: string, saved: SavedFilters | undefined, runColumns?: () => Map<string, string>,
): CompiledFilter | null {
  const where = viewWhere(saved);
  if (where.length === 0) return null;
  if (!readsRunState(where)) return compileWhere(where, new Map());
  const runs = runColumns?.() ?? sheetRunColumns(sheetId, userId, getSheetColumns(sheetId, userId, false));
  return compileWhere(where, runs);
}

export type SaveFiltersResult = { ok: true } | { fail: 'invalid' | 'not_found'; error: string };

// PUT /api/sheets/:id/column-filters: {column: {type, value?, values?}} or
// null to clear. A filter on a column the sheet doesn't have would hide every
// row with no header left to clear it from, so it's refused, as is a run-state
// filter on a column no run fills.
export function saveColumnFilters(sheetId: string, userId: string, raw: unknown): SaveFiltersResult {
  let stored: string | null = null;
  if (raw !== null && raw !== undefined) {
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return { fail: 'invalid', error: 'columnFilters must map column names to a condition, or be null.' };
    }
    const cleaned: ColumnFilters = {};
    for (const [column, f] of Object.entries(raw as Record<string, unknown>)) {
      if (column.trim() === '') return { fail: 'invalid', error: 'columnFilters keys must be non-empty column names.' };
      // A blank "contains" is no filter (clearing the box removes it).
      const saved = f as { type?: unknown; value?: unknown } | null;
      if (saved?.type === 'contains' && typeof saved.value === 'string' && saved.value.trim() === '') continue;
      const condition = columnFilterCondition(column, f);
      if (typeof condition === 'string') return { fail: 'invalid', error: `columnFilters["${column}"]: ${condition}` };
      cleaned[column] = toColumnFilter(condition);
    }
    if (Object.keys(cleaned).length > 0) stored = JSON.stringify(cleaned);
  }
  const owns = db.prepare('SELECT column_filters FROM sheets WHERE id = ? AND user_id = ? AND trash_id IS NULL')
    .get(sheetId, userId) as { column_filters: string | null } | undefined;
  if (!owns) return { fail: 'not_found', error: 'Sheet not found' };
  if (stored !== null) {
    const columns = getSheetColumns(sheetId, userId);
    const filters = JSON.parse(stored) as ColumnFilters;
    const missing = Object.keys(filters).filter(c => !columns.includes(c));
    if (missing.length > 0) {
      return { fail: 'invalid', error: `Filter references unknown column${missing.length > 1 ? 's' : ''}: `
        + `${missing.map(c => `"${c}"`).join(', ')}.` };
    }
    // The app saves every column's filter at once: one saved before (on a run
    // column whose status column was deleted since) isn't checked again, so it
    // doesn't block changes to the others.
    const before = parseColumnFilters(owns.column_filters);
    const changed = Object.fromEntries(Object.entries(filters)
      .filter(([column, f]) => JSON.stringify(before[column] ?? null) !== JSON.stringify(f)));
    const where = gridWhere({}, changed);
    const runColumns = readsRunState(where) ? sheetRunColumns(sheetId, userId, columns) : new Map<string, string>();
    const invalid = checkWhere(where, { columns, runColumns });
    if (invalid) return { fail: 'invalid', error: invalid };
  }
  db.prepare("UPDATE sheets SET column_filters = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .run(stored, sheetId, userId);
  return { ok: true };
}
