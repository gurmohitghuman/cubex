// A column's most common values with their counts: what the grid's "is any
// of" offers (GET /api/sheets/:id/values). Counted over the rows the active
// view's OTHER filters pass, so picking values here never hides the ones this
// column's own filter left out; by the same group-by count read_rows' group_by
// answers (services/row-aggregate.ts), so values compare as any_of does.
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { fillingColumns } from '../lib/field-fill-columns';
import { AGGREGATE_TOP_GROUPS } from '../lib/constants-query';
import { compileWhere } from '../lib/row-filter/sql';
import { isGroup } from '../lib/row-filter/where';
import { gridWhere, parseColumnFilters, parseEmptyFilter } from '../lib/row-filter/grid';
import { parseRowFilter, readsRunState } from '../lib/views/filters';
import { sheetRunColumns } from './row-filter';
import { listViews } from './view-store';
import { aggregateRows } from './row-aggregate';

export interface ValueCounts {
  values: Array<{ value: string; count: number }>;
  // Rows whose cell is empty, other values seen, rows counted, and whether
  // more values exist than `values` lists.
  empty: number;
  distinct: number;
  rows: number;
  truncated: boolean;
}
export type ValueCountsOutcome =
  | { ok: ValueCounts } | { tooMany: string } | { stopped: true } | { busy: string }
  | { fail: 'invalid' | 'not_found' | 'view_changed'; error: string };

type SheetFilters = { empty_filter: string | null; column_filters: string | null; row_filter: string | null };

export async function columnValueCounts(
  sheetId: string, userId: string, column: unknown, viewId: unknown, stop?: () => boolean,
): Promise<ValueCountsOutcome> {
  const sheet = db.prepare(`SELECT empty_filter, column_filters, row_filter FROM sheets WHERE id = ? AND user_id = ?
    AND trash_id IS NULL`).get(sheetId, userId) as SheetFilters | undefined;
  if (!sheet) return { fail: 'not_found', error: 'Sheet not found' };
  const columns = getSheetColumns(sheetId, userId, false);
  if (typeof column !== 'string' || !columns.includes(column)) {
    return { fail: 'invalid', error: 'Unknown column.' };
  }
  const active = (listViews(sheetId, userId, columns) ?? []).find(v => v.active);
  if (typeof viewId === 'string' && viewId && active && active.id !== viewId) {
    return { fail: 'view_changed', error: 'Another view is showing now. Reloading.' };
  }
  if (fillingColumns(sheetId, userId).includes(column)) {
    return { fail: 'invalid', error: `"${column}" is still filling. Its values can be counted once it is done.` };
  }
  // The view's filters without this column's own: its header filter, its
  // empty filter, and its other top-level conditions (the filter panel's; one
  // inside a group stays, since leaving it out could narrow the rows).
  const empty = parseEmptyFilter(sheet.empty_filter), byColumn = parseColumnFilters(sheet.column_filters);
  delete empty[column];
  delete byColumn[column];
  const rest = parseRowFilter(sheet.row_filter).filter(item => isGroup(item) || item.column !== column);
  const where = [...gridWhere(empty, byColumn), ...rest];
  const runs = readsRunState(where) ? sheetRunColumns(sheetId, userId, columns) : new Map<string, string>();
  const filter = where.length ? compileWhere(where, runs) : null;
  const spec = { groupBy: [column], aggregates: [] };
  // One more than shown, so the empty group never pushes a value off the list.
  const out = await aggregateRows(sheetId, userId, spec, filter, { top: AGGREGATE_TOP_GROUPS + 1, stop });
  if ('stopped' in out || 'busy' in out) return out;
  if ('error' in out) return { tooMany: out.error };
  const values = out.ok.groups.filter(g => g.group[column] !== '' && !g.cut)
    .slice(0, AGGREGATE_TOP_GROUPS).map(g => ({ value: g.group[column], count: g.count }));
  const distinct = out.ok.group_count - (out.empty > 0 ? 1 : 0);
  return {
    ok: { values, empty: out.empty, distinct, rows: out.ok.rows_matched, truncated: distinct > values.length },
  };
}
