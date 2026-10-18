// Column names inside a view (pure): its three filter parts and its hidden
// columns. A column rename or delete rewrites them (services/view-columns.ts),
// as it does the sheet's own filters; a filter left on a gone column would
// hide rows with no header left to clear it from.
import {
  activeWhere, groupItems, isGroup, isOrGroup, type FilterCondition, type WhereItem,
} from '../row-filter/where';
import { parseRowFilter, type ViewFilters } from './filters';

export interface ViewColumnFields extends ViewFilters { hidden_columns?: string | null }

// A column's new name, or null when it is gone.
type ColumnMap = (column: string) => string | null;
// A row-filter item after a rename or delete: itself (renamed), or gone and
// passing every row ('all'), or gone and never counted ('drop').
type Mapped = WhereItem | 'all' | 'drop';

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
  // What a condition on a gone column becomes: 'all' (it passed every row
  // from now on) when on, 'drop' (it never counted) when off.
  const mapCondition = (c: FilterCondition): Mapped => {
    if (c.column === undefined) return c;
    const next = to(c.column);
    if (next === c.column) return c;
    changed = true;
    if (next !== null) return { ...c, column: next };
    return c.enabled === false ? 'drop' : 'all';
  };
  // An AND group leaves out what passes every row; an OR group holding one
  // passes every row itself (keeping the rest would narrow the rows: they no
  // longer pass through the gone one). A group left empty goes as its items did.
  const mapItem = (item: WhereItem): Mapped => {
    if (!isGroup(item)) return mapCondition(item);
    const mapped = groupItems(item).map(mapItem).filter(m => m !== 'drop');
    const kept = mapped.filter((m): m is WhereItem => m !== 'all');
    // An AND group left with only off conditions passes every row too (it no
    // longer counts, and its gone condition did): kept, an OR above would narrow.
    if (kept.length < mapped.length && (isOrGroup(item) || activeWhere(kept).length === 0)) return 'all';
    if (kept.length) return isOrGroup(item) ? { or: kept } : { and: kept };
    return 'drop';
  };
  const out = parseRowFilter(raw).map(mapItem).filter((m): m is WhereItem => m !== 'all' && m !== 'drop');
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
