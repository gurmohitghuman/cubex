// read_rows' and REST rows/query's `row_ids`: exactly the rows named, by their
// stable ids, in the order asked, read by primary key (never the sheet). An id
// that isn't a row of this sheet (deleted, in the trash, another sheet's, never
// a row) is listed in `missing`. With include_status a failed run cell's error
// is the full text its run recorded (services/run-cell-errors.ts), where a page
// read says what the cell holds. Each row carries its updated_at. Over MCP the
// rows stop at about MCP_ROWS_BY_ID_MAX_CHARS; the ids left are in unread_ids.
import { db } from '../lib/db';
import { getSheetColumns, parseRowData } from '../lib/sql-helpers';
import { isoTime } from '../lib/row-since';
import { validateQuery, type RowQuery } from './row-query-input';
import { sheetRunColumns } from './row-filter';
import { shapeRows, versionsOf, type PageRow } from './row-project';
import { fullRunErrors } from './run-cell-errors';
import type { RowQueryResult } from './row-query-result';

type IdRow = PageRow & { updated_at: string };

// By primary key: + keeps a planner without statistics off the sheet indexes.
export const ROWS_BY_ID_SQL = `SELECT id, row_index, data, updated_at FROM rows
  WHERE id IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?`;

export function readRowsById(sheetId: string, userId: string, q: RowQuery): RowQueryResult {
  const ids = q.rowIds!;
  // One snapshot: the rows and the versions they answer with.
  return db.transaction((): RowQueryResult => {
    const versions = versionsOf(sheetId, userId);
    if (!versions) return { fail: 'invalid', error: 'Sheet not found' };
    const columns = getSheetColumns(sheetId, userId, false);
    const invalid = validateQuery(columns, q);
    if (invalid) return { fail: 'invalid', error: invalid };
    const found = new Map((db.prepare(ROWS_BY_ID_SQL).all(JSON.stringify(ids), sheetId, userId) as IdRow[])
      .map(r => [r.id, r]));
    const page = ids.flatMap(id => found.get(id) ?? []);
    const missing = ids.filter(id => !found.has(id));
    const runs = q.includeStatus ? sheetRunColumns(sheetId, userId, columns) : null;
    const errors = runs
      ? fullRunErrors(sheetId, userId, page.map(r => ({ ...r, data: parseRowData(r.data) })), runs, q.columns)
      : undefined;
    const shaped = shapeRows(sheetId, userId, page, q, runs, errors)
      .map((r, i) => ({ id: r.id, index: r.index, updated_at: isoTime(page[i].updated_at), data: r.data }));
    const { rows, unread } = fitChars(shaped, q.maxChars);
    return { ok: { rows, missing, ...(unread.length > 0 ? { unread_ids: unread } : {}), ...versions } };
  })();
}

// Rows in order until about `max` characters (always at least one); the ids of the rest.
function fitChars<T extends { id: string }>(rows: T[], max?: number): { rows: T[]; unread: string[] } {
  if (max === undefined) return { rows, unread: [] };
  let used = 0, kept = 0;
  for (const r of rows) {
    used += JSON.stringify(r).length + 1;
    if (kept > 0 && used > max) break;
    kept++;
  }
  return { rows: rows.slice(0, kept), unread: rows.slice(kept).map(r => r.id) };
}
