// One row-query contract (parse, validate, filter, page) for read_rows and
// /api/v1 rows/query. The `where` grammar is lib/row-filter (where.ts),
// checked and compiled to SQL by services/row-filter.ts: SQLite checks every
// row, a slice at a time between other requests, and only the page's rows are
// read.
import { db } from '../lib/db';
import { getSheetColumns, parseRowData } from '../lib/sql-helpers';
import { fillingColumns, overlayFilling } from '../lib/field-fill-columns';
import { rowWithStatus } from '../lib/row-filter/status-rows';
import { pickName, pickValue } from '../lib/row-select/paths';
import { aggregateColumns } from '../lib/row-aggregate/spec';
import { scanFiltered } from '../lib/filtered-scan';
import type { CompiledFilter } from '../lib/row-filter/sql';
import { prepareWhere, sheetRunColumns } from './row-filter';
import { withView } from './view-read';
import { validateQuery, type RowQuery } from './row-query-input';
import { aggregateRows } from './row-aggregate';

export type { WhereItem } from '../lib/row-filter/where';
export { parseRowQueryBody, type RowQuery } from './row-query-input';

type PageRow = { id: string; row_index: number; data: string };
// busy: a heavy operation holds the sheet (aggregates wait for it; REST answers 409).
type QueryFail = { fail: 'invalid' | 'version_conflict' | 'busy'; error: string };
export type RowQueryResult = { ok: Record<string, unknown> } | QueryFail;

// Own-property cell read: row data is plain JSON.parse output, so a sparse
// row's missing "constructor"/"toString" cell would otherwise resolve to the
// inherited prototype member (non-empty to filters, dropped by stringify).
export const cellOf = (data: Record<string, string>, column: string): string =>
  Object.prototype.hasOwnProperty.call(data, column) ? data[column] ?? '' : '';

type Versions = { data_version: number; row_generation: number };
const versionsOf = (sheetId: string, userId: string) => db.prepare(
  'SELECT data_version, row_generation FROM sheets WHERE id = ? AND user_id = ?',
).get(sheetId, userId) as Versions | undefined;

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
  const prepared = prepareWhere(sheetId, userId, q.where!, columns);
  if ('error' in prepared) return { fail: { fail: 'invalid', error: prepared.error } };
  const runs = prepared.ok.runColumns;
  return { columns, filter: prepared.ok.filter, runColumns: runs.size > 0 ? runs : null };
}

// A filtered read scans the sheet in slices between other requests
// (lib/filtered-scan.ts). The versions it answers with are the ones from
// before the scan, so a write meanwhile fails the next page's fence. When a
// sort or replace moved the rows meanwhile (row_generation), a page of a
// fenced walk answers "restart paging"; a first page is read again, once.
export async function queryRows(sheetId: string, userId: string, query: RowQuery): Promise<RowQueryResult> {
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
  const rows = page.map(r => ({ id: r.id, index: r.row_index, data: parseRowData(r.data) }));
  overlayFilling(rows, fillingColumns(sheetId, userId));
  const runs = q.includeStatus ? prep.runColumns ?? sheetRunColumns(sheetId, userId, columns) : null;
  for (const r of rows) (r as { data: unknown }).data = projectRow(r.data, q, runs);
  return { ok: { rows, next_cursor, ...versions } };
}

// A row's data as the query asked: every column, the columns named, or picks
// (a value out of a JSON cell, a column under another name); run columns as
// {status, value, error} with include_status.
function projectRow(
  data: Record<string, string>, q: RowQuery, runs: Map<string, string> | null,
): Record<string, unknown> {
  const plain = runs ? rowWithStatus(data, runs, q.columns) : null;
  if (!q.picks) {
    if (plain) return plain;
    return q.columns ? Object.fromEntries(q.columns.map(c => [c, cellOf(data, c)])) : data;
  }
  return Object.fromEntries(q.picks.map(p => [pickName(p),
    p.path ? pickValue(cellOf(data, p.column), p.path) : plain ? plain[p.column] : cellOf(data, p.column)]));
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
