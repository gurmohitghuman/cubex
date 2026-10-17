// A view's filters (pure). Stored in three parts, the way the grid edits them:
// empty_filter and column_filters (one condition per column, lib/row-filter/
// grid.ts) and row_filter, a `where` list for what those can't hold: a
// run-state check on any run column, an OR group, a second condition on a
// column. Together they are one `where` (lib/row-filter/where.ts), the grammar
// read_rows and export take.
import { isStateOp } from '../row-filter/ops';
import {
  conditionValueError, isOrGroup, parseWhere, type FilterCondition, type WhereItem,
} from '../row-filter/where';
import {
  gridWhere, parseColumnFilters, parseEmptyFilter, toColumnFilter, type ColumnFilters, type EmptyFilter,
} from '../row-filter/grid';

export interface ViewFilters {
  empty_filter: string | null;
  column_filters: string | null;
  row_filter: string | null;
}

const NO_FILTERS: ViewFilters = { empty_filter: null, column_filters: null, row_filter: null };

// Tolerant, like the grid's: a malformed item is dropped, never a failed read.
export function parseRowFilter(raw: string | null | undefined): WhereItem[] {
  if (!raw) return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(value) || value.length === 0) return [];
  const out: WhereItem[] = [];
  for (const item of value) {
    const parsed = parseWhere([item]);
    if ('error' in parsed) continue;
    const one = parsed.where[0];
    const conditions = isOrGroup(one) ? one.or : [one];
    if (conditions.every(c => conditionValueError(c) === null)) out.push(one);
  }
  return out;
}

// The whole filter as one `where` (empty: every row).
export function viewWhere(f: ViewFilters | undefined): WhereItem[] {
  if (!f) return [];
  return [
    ...gridWhere(parseEmptyFilter(f.empty_filter), parseColumnFilters(f.column_filters)),
    ...parseRowFilter(f.row_filter),
  ];
}

const json = (v: object): string | null => (Object.keys(v).length === 0 ? null : JSON.stringify(v));

// A checked `where` into the three stored parts: each column's first
// condition goes where the grid shows it (its header), the rest to row_filter.
export function splitWhere(where: readonly WhereItem[]): ViewFilters {
  if (where.length === 0) return { ...NO_FILTERS };
  const empty: EmptyFilter = {};
  const columns: ColumnFilters = {};
  const rest: WhereItem[] = [];
  for (const item of where) {
    if (isOrGroup(item) || item.column === undefined) { rest.push(item); continue; }
    const c: FilterCondition = item;
    const column = c.column!;
    if ((c.operator === 'empty' || c.operator === 'not_empty') && !(column in empty)) {
      empty[column] = c.operator;
    } else if (c.operator !== 'empty' && c.operator !== 'not_empty' && !(column in columns)) {
      columns[column] = toColumnFilter(c);
    } else {
      rest.push(c);
    }
  }
  return {
    empty_filter: json(empty),
    column_filters: json(columns),
    row_filter: rest.length ? JSON.stringify(rest) : null,
  };
}

// Whether reading this filter needs the sheet's run columns.
export const readsRunState = (where: readonly WhereItem[]): boolean =>
  where.some(item => (isOrGroup(item) ? item.or : [item]).some(c => isStateOp(c.operator)));
