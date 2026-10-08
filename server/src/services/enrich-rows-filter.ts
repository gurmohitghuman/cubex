// "Rows in the current filter": the sheet's saved filters (empty_filter,
// column_filters) as the same SQL clause the grid's reads use, so a run takes
// exactly the rows the user sees. Other modes take every row.
import { db } from '../lib/db';
import { parseEmptyFilter, buildEmptyFilterSql } from '../lib/empty-filter';
import { parseColumnFilters, buildColumnFiltersSql } from '../lib/column-filters';
import type { EnrichRowsMode } from '../lib/enrich-run-config';

export type RowFilterSql = { clause: string; params: unknown[] };
export interface RowFilter { sql: RowFilterSql; count: number | null }

export function rowFilterSql(sheetId: string, userId: string, mode: EnrichRowsMode): RowFilterSql {
  if (mode !== 'filter') return { clause: '', params: [] };
  const sheet = db.prepare('SELECT empty_filter, column_filters FROM sheets WHERE id = ? AND user_id = ?')
    .get(sheetId, userId) as { empty_filter: string | null; column_filters: string | null } | undefined;
  const empty = buildEmptyFilterSql(parseEmptyFilter(sheet?.empty_filter));
  const contains = buildColumnFiltersSql(parseColumnFilters(sheet?.column_filters));
  return { clause: empty.clause + contains.clause, params: [...empty.params, ...contains.params] };
}

export function enrichRowFilter(sheetId: string, userId: string, mode: EnrichRowsMode): RowFilter {
  if (mode !== 'filter') return { sql: { clause: '', params: [] }, count: null };
  const sql = rowFilterSql(sheetId, userId, mode);
  const count = (db.prepare(`SELECT COUNT(*) AS c FROM rows WHERE sheet_id = ? AND user_id = ?${sql.clause}`)
    .get(sheetId, userId, ...sql.params) as { c: number }).c;
  return { sql, count };
}
