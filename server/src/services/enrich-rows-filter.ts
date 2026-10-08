// "Rows in the current filter": the sheet's saved filters (empty_filter,
// column_filters) as the same SQL clause the grid's reads use, so a run takes
// exactly the rows the user sees. Other modes take every row.
import { db } from '../lib/db';
import { parseEmptyFilter, buildEmptyFilterSql } from '../lib/empty-filter';
import { parseColumnFilters, buildColumnFiltersSql } from '../lib/column-filters';
import type { EnrichRowsMode } from '../lib/enrich-run-config';

export interface RowFilter { sql: { clause: string; params: unknown[] }; count: number | null }

export function enrichRowFilter(sheetId: string, userId: string, mode: EnrichRowsMode): RowFilter {
  if (mode !== 'filter') return { sql: { clause: '', params: [] }, count: null };
  const sheet = db.prepare('SELECT empty_filter, column_filters FROM sheets WHERE id = ? AND user_id = ?')
    .get(sheetId, userId) as { empty_filter: string | null; column_filters: string | null } | undefined;
  const empty = buildEmptyFilterSql(parseEmptyFilter(sheet?.empty_filter));
  const contains = buildColumnFiltersSql(parseColumnFilters(sheet?.column_filters));
  const sql = { clause: empty.clause + contains.clause, params: [...empty.params, ...contains.params] };
  const count = (db.prepare(`SELECT COUNT(*) AS c FROM rows WHERE sheet_id = ? AND user_id = ?${sql.clause}`)
    .get(sheetId, userId, ...sql.params) as { c: number }).c;
  return { sql, count };
}
