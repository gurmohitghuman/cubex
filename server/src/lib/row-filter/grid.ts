// The grid's saved filters (pure): sheets.empty_filter, {column: 'empty' |
// 'not_empty'}, and sheets.column_filters, {column: {type, value?, values?}}
// with `type` one of the row-filter operators (ops.ts; saves from before them
// hold only 'contains'). One condition per column, every one must pass, the
// same `where` the API takes (where.ts), compiled by sql.ts. Reading stays
// tolerant: a malformed or tampered entry is dropped, never a failed read.
import { isFilterOp } from './ops';
import { conditionValueError, type FilterCondition } from './where';

export type EmptyFilter = Record<string, 'empty' | 'not_empty'>;
export interface ColumnFilter { type: FilterCondition['operator']; value?: string; values?: string[] }
export type ColumnFilters = Record<string, ColumnFilter>;

const parseObject = (raw: string | null | undefined): Record<string, unknown> => {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
};

export function parseEmptyFilter(raw: string | null | undefined): EmptyFilter {
  const out: EmptyFilter = {};
  for (const [col, mode] of Object.entries(parseObject(raw))) {
    if (col && (mode === 'empty' || mode === 'not_empty')) out[col] = mode;
  }
  return out;
}

// One column's filter as a condition, or an error saying what's wrong with it.
export function columnFilterCondition(column: string, raw: unknown): FilterCondition | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return 'A column filter is {type, value} or {type, values}.';
  }
  const f = raw as Record<string, unknown>;
  const op = String(f.type);
  if (!isFilterOp(op)) return `Unknown filter type "${op}".`;
  if (f.value !== undefined && typeof f.value !== 'string') return 'A filter value is text.';
  if (f.values !== undefined && (!Array.isArray(f.values) || f.values.some(v => typeof v !== 'string'))) {
    return 'Filter values are a list of text.';
  }
  const condition: FilterCondition = {
    column, operator: op,
    ...(f.value !== undefined ? { value: f.value as string } : {}),
    ...(f.values !== undefined ? { values: f.values as string[] } : {}),
  };
  return conditionValueError(condition) ?? condition;
}

export function parseColumnFilters(raw: string | null | undefined): ColumnFilters {
  const out: ColumnFilters = {};
  for (const [col, f] of Object.entries(parseObject(raw))) {
    if (!col) continue;
    const c = columnFilterCondition(col, f);
    if (typeof c !== 'string') out[col] = toColumnFilter(c);
  }
  return out;
}

export const toColumnFilter = (c: FilterCondition): ColumnFilter => ({
  type: c.operator,
  ...(c.value !== undefined ? { value: c.value } : {}),
  ...(c.values !== undefined ? { values: c.values } : {}),
});

// Both saved filters as one `where` (empty: no filter).
export function gridWhere(empty: EmptyFilter, columns: ColumnFilters): FilterCondition[] {
  return [
    ...Object.entries(empty).map(([column, operator]) => ({ column, operator })),
    ...Object.entries(columns).map(([column, f]) => ({ column, operator: f.type, value: f.value, values: f.values })),
  ];
}
