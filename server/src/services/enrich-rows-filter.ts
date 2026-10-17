// "Rows in the current filter": the sheet's saved filters (empty_filter,
// column_filters) as the same SQL clause the grid's reads use, so a run takes
// exactly the rows the user sees. Other modes take every row.
import { db } from '../lib/db';
import { savedFilterSql } from './row-filter';
import type { EnrichRowsMode } from '../lib/enrich-run-config';

export type RowFilterSql = { clause: string; params: unknown[] };

export function rowFilterSql(sheetId: string, userId: string, mode: EnrichRowsMode): RowFilterSql {
  if (mode !== 'filter') return { clause: '', params: [] };
  const sheet = db.prepare('SELECT empty_filter, column_filters FROM sheets WHERE id = ? AND user_id = ?')
    .get(sheetId, userId) as { empty_filter: string | null; column_filters: string | null } | undefined;
  const saved = savedFilterSql(sheetId, userId, sheet);
  return saved ? { clause: ` AND (${saved.sql})`, params: saved.params } : { clause: '', params: [] };
}
