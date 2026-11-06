// read_rows' and REST rows/query's `updated_since`: the rows whose cells
// changed at or after a time, oldest change first, a page at a time through the
// (sheet_id, updated_at) index (migration 050; its entries end with the rowid),
// never a scan and never a sort. Every writer of rows.data sets updated_at in
// the same statement; a sort, which only moves rows, doesn't. Deleted rows
// don't come back (list_trash has them).
//
// A walk is fixed by its first page: `until` (the server's time then) is the
// newest change it reads, so it ends even while rows keep changing, and as_of
// (ROWS_SINCE_AS_OF_SLACK_SECONDS before that, never before updated_since) is
// the updated_since for the next walk. Rows changed after `until` move past the
// walk's end and come in the next one. updated_at is whole seconds, so the next
// walk starts at as_of's second, inclusive: nothing is missed, and a row can
// come back again (dedupe by id). Its cursor names the sheet, so another
// sheet's is refused.
//
// The cells are what the rows hold: a column still filling (a clean, formula
// or lookup fill, an answer field) is NOT shown as "⏳ Processing..." as other
// reads show it. A fill writes, and stamps, only the rows whose value changes,
// so a placeholder kept in a copy would never be answered again. `filling`
// names those columns instead: the rows the fill changes come in a later read.
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { fillingColumns } from '../lib/field-fill-columns';
import { ROWS_SINCE_AS_OF_SLACK_SECONDS } from '../lib/constants-query';
import { API_V1_DEFAULT_ROWS_PAGE } from '../lib/api-v1-constants';
import { decodeSinceCursor, encodeSinceCursor, isoTime, parseSinceTime, type SinceCursor } from '../lib/row-since';
import { validateQuery, type RowQuery } from './row-query-input';
import { sheetRunColumns } from './row-filter';
import { cutRows, shapeRows, versionsOf, type PageRow } from './row-project';
import type { RowQueryResult } from './row-query-result';

type SinceRow = PageRow & { rid: number; updated_at: string };

// The rows after (t, r) in (updated_at, rowid) order, up to `until`. A walk
// starts at (updated_since, 0), so the row value is its only lower bound: with
// statistics, a separate `updated_at >= ?` made SQLite skip-scan the index and
// sort every row matching at a million rows (0.8 s a page instead of 0.2 ms).
// INDEXED BY: a schema without migration 050's index fails here, never scans.
export const ROWS_SINCE_SQL = `SELECT rowid AS rid, id, row_index, data, updated_at
  FROM rows INDEXED BY idx_rows_sheet_updated
  WHERE sheet_id = ? AND +user_id = ? AND (updated_at, rowid) > (?, ?) AND updated_at <= ?
  ORDER BY updated_at, rowid LIMIT ?`;

const RESTART = 'This cursor belongs to an updated_since read from another time: start again without cursor.';
const OTHER_SHEET = 'This cursor belongs to an updated_since read of another sheet: start again without cursor.';

export function readRowsSince(sheetId: string, userId: string, q: RowQuery): RowQueryResult {
  const since = parseSinceTime(q.updatedSince);
  if ('error' in since) return { fail: 'invalid', error: since.error };
  const at = q.sinceCursor === undefined ? null : decodeSinceCursor(q.sinceCursor);
  if (q.sinceCursor !== undefined && (!at || at.since !== since.sql)) return { fail: 'invalid', error: RESTART };
  if (at && at.sheet !== sheetId) return { fail: 'invalid', error: OTHER_SHEET };
  const limit = q.limit ?? API_V1_DEFAULT_ROWS_PAGE;
  // One snapshot: the page, the versions, the columns filling and the time it was read at.
  return db.transaction((): RowQueryResult => {
    const versions = versionsOf(sheetId, userId);
    if (!versions) return { fail: 'invalid', error: 'Sheet not found' };
    const columns = getSheetColumns(sheetId, userId, false);
    const invalid = validateQuery(columns, q);
    if (invalid) return { fail: 'invalid', error: invalid };
    const walk = at ?? startWalk(sheetId, since.sql);
    const page = db.prepare(ROWS_SINCE_SQL)
      .all(sheetId, userId, walk.t, walk.r, walk.until, limit + 1) as SinceRow[];
    const hasMore = page.length > limit;
    if (hasMore) page.length = limit;
    const last = page[page.length - 1];
    const next_cursor = hasMore ? encodeSinceCursor({ ...walk, t: last.updated_at, r: last.rid }) : null;
    const runs = q.includeStatus ? sheetRunColumns(sheetId, userId, columns) : null;
    const rows = shapeRows(sheetId, userId, page, q, runs, { stored: true })
      .map((r, i) => ({ id: r.id, index: r.index, updated_at: isoTime(page[i].updated_at), data: r.data }));
    const cut = cutRows(rows, q, runs);
    // The columns read that are filling now (with picks: the columns they read).
    const filling = fillingColumns(sheetId, userId).filter(c => !q.columns || q.columns.includes(c));
    return { ok: { rows, ...(cut && { truncated_cells: cut }), next_cursor, as_of: isoTime(walk.asOf), filling,
      ...versions } };
  })();
}

// A first page: from updated_since's second (rowid 0: every row of it) up to now.
function startWalk(sheet: string, since: string): SinceCursor {
  const now = db.prepare(`SELECT datetime('now') AS until, datetime('now', ?) AS back`)
    .get(`-${ROWS_SINCE_AS_OF_SLACK_SECONDS} seconds`) as { until: string; back: string };
  return { sheet, since, t: since, r: 0, until: now.until, asOf: now.back > since ? now.back : since };
}
