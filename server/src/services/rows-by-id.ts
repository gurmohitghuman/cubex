// read_rows' and REST rows/query's `row_ids`: exactly the rows named, by their
// stable ids, in the order asked, read by primary key (never the sheet). An id
// that isn't a row of this sheet (deleted, in the trash, another sheet's, never
// a row) is listed in `missing`. With include_status a failed run cell's error
// is the full text its run recorded (services/run-cell-errors.ts), where a page
// read says what the cell holds. Each row carries its updated_at. Over MCP the
// rows stop at about MCP_ROWS_BY_ID_MAX_CHARS; the ids left are in unread_ids.
// With max_chars_per_cell that cap counts the rows as cut and each one's
// cut_cells entry, and cut_cells keeps only the rows returned.
import { db } from '../lib/db';
import { readTransaction } from '../lib/db-transaction';
import { getSheetColumns, parseRowData } from '../lib/sql-helpers';
import { isoTime } from '../lib/row-since';
import { validateQuery, type RowQuery } from './row-query-input';
import { sheetRunColumns } from './row-filter';
import { cutRows, shapeRows, versionsOf, type PageRow } from './row-project';
import { emptyCutCells, type CutCells } from '../lib/row-select/cut-cells';
import { fullRunErrors } from './run-cell-errors';
import type { RowQueryResult } from './row-query-result';

type IdRow = PageRow & { updated_at: string };

// By primary key: + keeps a planner without statistics off the sheet indexes.
export const ROWS_BY_ID_SQL = `SELECT id, row_index, data, updated_at FROM rows
  WHERE id IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?`;

export function readRowsById(sheetId: string, userId: string, q: RowQuery): RowQueryResult {
  const ids = q.rowIds!;
  // One snapshot: the rows and the versions they answer with.
  return readTransaction((): RowQueryResult => {
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
    const shaped = shapeRows(sheetId, userId, page, q, runs, { errors })
      .map((r, i) => ({ id: r.id, index: r.index, updated_at: isoTime(page[i].updated_at), data: r.data }));
    const cut = cutRows(shaped, q, runs);
    const { rows, unread } = fitChars(shaped, q.maxChars, cut);
    const listed = cut && (unread.length > 0 ? keptEntries(cut, rows) : cut);
    return { ok: { rows, ...(listed && { cut_cells: listed }), missing,
      ...(unread.length > 0 ? { unread_ids: unread } : {}), ...versions } };
  })();
}

// Rows in order until about `max` characters (always at least one), each
// counted with its cut_cells entry ("<row id>":{...}); the ids of the rest.
function fitChars<T extends { id: string }>(
  rows: T[], max?: number, cut?: CutCells,
): { rows: T[]; unread: string[] } {
  if (max === undefined) return { rows, unread: [] };
  let used = 0, kept = 0;
  for (const r of rows) {
    const entry = cut?.[r.id];
    used += JSON.stringify(r).length + 1 + (entry ? JSON.stringify(r.id).length + JSON.stringify(entry).length + 2 : 0);
    if (kept > 0 && used > max) break;
    kept++;
  }
  return { rows: rows.slice(0, kept), unread: rows.slice(kept).map(r => r.id) };
}

// The cut_cells entries of the rows kept, in their order.
function keptEntries(cut: CutCells, rows: Array<{ id: string }>): CutCells {
  const out = emptyCutCells();
  for (const r of rows) if (cut[r.id]) out[r.id] = cut[r.id];
  return out;
}
