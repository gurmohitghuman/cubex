// One row-query contract (parse, validate, filter, page) for read_rows and
// /api/v1 rows/query. The `where` grammar is lib/row-filter (where.ts),
// checked and compiled to SQL by services/row-filter.ts: SQLite checks every
// row, a slice at a time between other requests, and only the page's rows are
// read. Reads by id (row_ids) and by time (updated_since) are their own:
// services/rows-by-id.ts and rows-since.ts.
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { fillingColumns } from '../lib/field-fill-columns';
import { aggregateColumns } from '../lib/row-aggregate/spec';
import { scanFiltered } from '../lib/filtered-scan';
import type { CompiledFilter } from '../lib/row-filter/sql';
import { prepareWhere, sheetRunColumns } from './row-filter';
import { withView } from './view-read';
import { checkMaxChars, checkPickedQuery, validateQuery, type RowQuery } from './row-query-input';
import { aggregateRows } from './row-aggregate';
import { cutRows, shapeRows, versionsOf, type PageRow, type Versions } from './row-project';
import { readRowsById } from './rows-by-id';
import { readRowsSince } from './rows-since';
import type { QueryFail, RowQueryResult } from './row-query-result';

export type { WhereItem } from '../lib/row-filter/where';
export { parseRowQueryBody, type RowQuery } from './row-query-input';
export type { RowQueryResult } from './row-query-result';

// The fences, the query's columns and its `where`, checked before any row is read.
function prepareQuery(
  sheetId: string, userId: string, q: RowQuery,
): { fail: QueryFail } | { columns: string[]; filter: CompiledFilter | null; runColumns: Map<string, string> | null } {
  const sheet = versionsOf(sheetId, userId);
  if (!sheet) return { fail: { fail: 'invalid', error: 'Sheet not found' } };
  const filtered = (q.where?.length ?? 0) > 0;
  if (q.expectedRowGeneration !== undefined && q.expectedRowGeneration !== sheet.row_generation) {
    return { fail: { fail: 'version_conflict', error: 'Sheet row order changed; restart paging.' } };
  }
  if (filtered && q.after >= 0 && q.expectedDataVersion === undefined) {
    return { fail: { fail: 'invalid', error: 'Filtered paging after the first page requires expected_data_version.' } };
  }
  if (filtered && q.after >= 0 && q.expectedRowGeneration === undefined) {
    return { fail: { fail: 'invalid',
      error: 'Filtered paging after the first page requires expected_row_generation.' } };
  }
  if (q.expectedDataVersion !== undefined && q.expectedDataVersion !== sheet.data_version) {
    return { fail: { fail: 'version_conflict', error: 'Sheet data changed; restart filtered paging.' } };
  }
  const columns = getSheetColumns(sheetId, userId, false);
  const invalid = validateQuery(columns, q);
  if (invalid) return { fail: { fail: 'invalid', error: invalid } };
  if (!filtered) return { columns, filter: null, runColumns: null };
  const prepared = prepareWhere(sheetId, userId, q.where!, columns, q.viewWhere);
  if ('error' in prepared) return { fail: { fail: 'invalid', error: prepared.error } };
  const runs = prepared.ok.runColumns;
  return { columns, filter: prepared.ok.filter, runColumns: runs.size > 0 ? runs : null };
}

// A filtered read scans the sheet in slices between other requests
// (lib/filtered-scan.ts). The versions it answers with are the ones from
// before the scan, so a write meanwhile fails the next page's fence. When a
// sort or replace moved the rows meanwhile (row_generation), a page of a
// fenced walk answers "restart paging"; a first page is read again, once.
// row_ids and updated_since are reads of their own (services/rows-by-id.ts,
// rows-since.ts), refused with what they don't take before anything is read.
export async function queryRows(sheetId: string, userId: string, query: RowQuery): Promise<RowQueryResult> {
  const picked = checkMaxChars(query.maxCharsPerCell) ?? checkPickedQuery(query);
  if (picked) return { fail: 'invalid', error: picked };
  if (query.rowIds) return readRowsById(sheetId, userId, query);
  if (query.updatedSince !== undefined) return readRowsSince(sheetId, userId, query);
  const viewed = withView(sheetId, userId, query);
  if ('fail' in viewed) return viewed;
  const out = viewed.query.aggregate
    ? await runAggregate(sheetId, userId, viewed.query)
    : await runQuery(sheetId, userId, viewed.query);
  return viewed.version && 'ok' in out ? { ok: { ...out.ok, view_version: viewed.version } } : out;
}

async function runQuery(sheetId: string, userId: string, q: RowQuery): Promise<RowQueryResult> {
  const prep = prepareQuery(sheetId, userId, q);
  if ('fail' in prep) return prep.fail;
  const { columns, filter } = prep;
  const limit = q.limit ?? 100;
  let versions: Versions | undefined, count: number | null = null, page: PageRow[] = [];
  for (let attempt = 0; ; attempt++) {
    versions = versionsOf(sheetId, userId);
    if (!versions) return { fail: 'invalid', error: 'Sheet not found' };
    if (!filter) {
      if (q.returnMode === 'count') {
        count = db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ? AND user_id = ?').pluck()
          .get(sheetId, userId) as number;
      } else {
        page = db.prepare(`SELECT id, row_index, data FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index > ?
          ORDER BY row_index ASC LIMIT ?`).all(sheetId, userId, q.after, limit + 1) as PageRow[];
      }
      break;
    }
    const counting = q.returnMode === 'count';
    const scan = await scanFiltered<PageRow>(sheetId, userId, filter,
      { after: q.after, limit: counting ? 0 : limit + 1, count: counting });
    count = scan.count;
    page = scan.rows;
    if (versionsOf(sheetId, userId)?.row_generation === versions.row_generation) break;
    const fenced = q.after >= 0 || q.expectedRowGeneration !== undefined || q.expectedDataVersion !== undefined;
    if (fenced || attempt === 1) return { fail: 'version_conflict', error: 'Sheet row order changed; restart paging.' };
  }

  if (q.returnMode === 'count') return { ok: { count, ...versions } };
  const hasMore = page.length > limit;
  if (hasMore) page = page.slice(0, limit);
  const next_cursor = hasMore ? page[page.length - 1].row_index : null;
  if (q.returnMode === 'ids') {
    return { ok: { rows: page.map(r => ({ id: r.id, index: r.row_index })), next_cursor, ...versions } };
  }
  const runs = q.includeStatus ? prep.runColumns ?? sheetRunColumns(sheetId, userId, columns) : null;
  const rows = shapeRows(sheetId, userId, page, q, runs);
  const cut = cutRows(rows, q, runs);
  return { ok: { rows, ...(cut && { truncated_cells: cut }), next_cursor, ...versions } };
}

// group_by / aggregates: the groups of the rows the `where` and view pass,
// with the versions from before the walk (services/row-aggregate.ts).
async function runAggregate(sheetId: string, userId: string, q: RowQuery): Promise<RowQueryResult> {
  const prep = prepareQuery(sheetId, userId, q);
  if ('fail' in prep) return prep.fail;
  const filling = fillingColumns(sheetId, userId).find(c => aggregateColumns(q.aggregate!).includes(c));
  if (filling) {
    return { fail: 'invalid', error: `"${filling}" is still filling from stored answers. Aggregate it once get_sheet `
      + 'no longer lists it in filling_columns.' };
  }
  const versions = versionsOf(sheetId, userId);
  if (!versions) return { fail: 'invalid', error: 'Sheet not found' };
  const out = await aggregateRows(sheetId, userId, q.aggregate!, prep.filter);
  if ('error' in out) return { fail: 'invalid', error: out.error };
  if ('stopped' in out) return { fail: 'invalid', error: 'The read stopped.' };
  if ('busy' in out) return { fail: 'busy', error: out.busy };
  return { ok: { ...out.ok, ...versions } };
}
