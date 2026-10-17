// Column names inside a view (pure): its three filter parts and its hidden
// columns. A column rename or delete rewrites them (services/view-columns.ts),
// as it does the sheet's own filters; a filter left on a gone column would
// hide rows with no header left to clear it from.
import { isOrGroup, type FilterCondition, type WhereItem } from '../row-filter/where';
import { parseRowFilter, type ViewFilters } from './filters';

export interface ViewColumnFields extends ViewFilters { hidden_columns?: string | null }

// A column's new name, or null when it is gone.
type ColumnMap = (column: string) => string | null;

function mapDict(raw: string | null, to: ColumnMap): string | null | undefined {
  if (!raw) return undefined;
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(raw); } catch { return undefined; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(obj)) {
    const next = to(column);
    if (next !== column) changed = true;
    if (next !== null) out[next] = value;
  }
  if (!changed) return undefined;
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

function mapRowFilter(raw: string | null, to: ColumnMap): string | null | undefined {
  if (!raw) return undefined;
  let changed = false;
  const mapCondition = (c: FilterCondition): FilterCondition | null => {
    if (c.column === undefined) return c;
    const next = to(c.column);
    if (next === c.column) return c;
    changed = true;
    return next === null ? null : { ...c, column: next };
  };
  const out: WhereItem[] = [];
  for (const item of parseRowFilter(raw)) {
    if (isOrGroup(item)) {
      // A condition gone from an OR group takes the group with it: keeping the
      // rest would narrow the rows (they no longer pass through the gone one).
      const or = item.or.map(mapCondition);
      if (or.every((c): c is FilterCondition => c !== null)) out.push({ or });
    } else {
      const c = mapCondition(item);
      if (c) out.push(c);
    }
  }
  if (!changed) return undefined;
  return out.length ? JSON.stringify(out) : null;
}

export function parseHiddenColumns(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? [...new Set(v.filter((c): c is string => typeof c === 'string' && c !== ''))] : [];
  } catch {
    return [];
  }
}

function mapHidden(raw: string | null | undefined, to: ColumnMap): string | null | undefined {
  const hidden = parseHiddenColumns(raw);
  const next = [...new Set(hidden.map(to).filter((c): c is string => c !== null))];
  if (next.length === hidden.length && next.every((c, i) => c === hidden[i])) return undefined;
  return next.length ? JSON.stringify(next) : null;
}

// The fields that change (undefined: untouched).
export function mapViewColumns(fields: ViewColumnFields, to: ColumnMap): Partial<ViewColumnFields> {
  const out: Partial<ViewColumnFields> = {};
  const empty = mapDict(fields.empty_filter, to);
  if (empty !== undefined) out.empty_filter = empty;
  const columns = mapDict(fields.column_filters, to);
  if (columns !== undefined) out.column_filters = columns;
  const rows = mapRowFilter(fields.row_filter, to);
  if (rows !== undefined) out.row_filter = rows;
  if ('hidden_columns' in fields) {
    const hidden = mapHidden(fields.hidden_columns, to);
    if (hidden !== undefined) out.hidden_columns = hidden;
  }
  return out;
}

export const renameTo = (from: string, to: string): ColumnMap => c => (c === from ? to : c);
export const dropColumn = (gone: string): ColumnMap => c => (c === gone ? null : c);
export const keepOnly = (live: ReadonlySet<string>): ColumnMap => c => (live.has(c) ? c : null);
