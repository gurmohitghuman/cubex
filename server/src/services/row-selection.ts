// One row-query contract (parse, validate, filter, page) for read_rows and
// /api/v1 rows/query. The `where` grammar is lib/row-filter (where.ts),
// checked and compiled to SQL by services/row-filter.ts: SQLite checks every
// row, a slice at a time between other requests, and only the page's rows are
// read.
import { db } from '../lib/db';
import { getSheetColumns, parseRowData } from '../lib/sql-helpers';
import { fillingColumns, overlayFilling } from '../lib/field-fill-columns';
import { parseWhere, type WhereItem } from '../lib/row-filter/where';
import { rowWithStatus } from '../lib/row-filter/status-rows';
import { scanFiltered } from '../lib/filtered-scan';
import type { CompiledFilter } from '../lib/row-filter/sql';
import { prepareWhere, sheetRunColumns } from './row-filter';
import { withView } from './view-read';

export type { WhereItem } from '../lib/row-filter/where';

export interface RowQuery {
  after: number;
  limit?: number;
  columns?: string[];
  where?: WhereItem[];
  returnMode: 'rows' | 'ids' | 'count';
  // Run columns' cells as {status, value, error} (lib/row-filter/status-rows.ts).
  includeStatus?: boolean;
  expectedDataVersion?: number;
  expectedRowGeneration?: number;
  // A saved view (id or name): its filters are ANDed with `where`, its visible
  // columns are the columns unless `columns` names them (services/view-read.ts).
  view?: string;
  // Paging through a view: the view_version the previous page answered.
  expectedViewVersion?: string;
}

type PageRow = { id: string; row_index: number; data: string };
type QueryFail = { fail: 'invalid' | 'version_conflict'; error: string };
export type RowQueryResult = { ok: Record<string, unknown> } | QueryFail;

export function parseRowQueryBody(
  body: unknown, maxLimit: number,
): { query: RowQuery } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Request body must be an object.' };
  const b = body as Record<string, unknown>;
  const int = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  if (b.cursor !== undefined && !int(b.cursor)) return { error: 'cursor must be a non-negative integer.' };
  if (b.limit !== undefined && (!int(b.limit) || b.limit === 0 || (b.limit as number) > maxLimit)) {
    return { error: `limit must be an integer from 1 to ${maxLimit}.` };
  }
  if (b.expected_data_version !== undefined && !int(b.expected_data_version)) {
    return { error: 'Invalid expected_data_version.' };
  }
  if (b.expected_row_generation !== undefined && !int(b.expected_row_generation)) {
    return { error: 'Invalid expected_row_generation.' };
  }
  if (b.columns !== undefined && (!Array.isArray(b.columns) || b.columns.length === 0
      || b.columns.some(c => typeof c !== 'string'))) return { error: 'columns must be a non-empty string array.' };
  let where: WhereItem[] | undefined;
  if (b.where !== undefined) {
    const parsed = parseWhere(b.where);
    if ('error' in parsed) return { error: parsed.error };
    where = parsed.where;
  }
  if (b.return_mode !== undefined && !['rows', 'ids', 'count'].includes(String(b.return_mode))) {
    return { error: 'return_mode must be rows, ids, or count.' };
  }
  if (b.include_status !== undefined && typeof b.include_status !== 'boolean') {
    return { error: 'include_status must be true or false.' };
  }
  if (b.view !== undefined && (typeof b.view !== 'string' || !b.view.trim())) {
    return { error: 'view must be a view name or id (get_sheet lists them).' };
  }
  if (b.expected_view_version !== undefined && typeof b.expected_view_version !== 'string') {
    return { error: 'Invalid expected_view_version.' };
  }
  return { query: {
    after: (b.cursor as number | undefined) ?? -1,
    limit: b.limit as number | undefined,
    columns: b.columns as string[] | undefined,
    where,
    returnMode: (b.return_mode as RowQuery['returnMode']) ?? 'rows',
    includeStatus: b.include_status === true,
    expectedDataVersion: b.expected_data_version as number | undefined,
    expectedRowGeneration: b.expected_row_generation as number | undefined,
    view: b.view as string | undefined,
    expectedViewVersion: b.expected_view_version as string | undefined,
  } };
}

function validateQuery(columns: string[], q: RowQuery): string | null {
  const known = new Set(columns);
  const requested = [...(q.columns ?? [])];
  const unknown = requested.filter(c => !known.has(c));
  if (unknown.length) return `Unknown column(s): ${[...new Set(unknown)].join(', ')}`;
  if (q.columns && new Set(q.columns).size !== q.columns.length) return 'columns must not contain duplicates';
  if (q.returnMode === 'count' && (q.after >= 0 || q.limit !== undefined || q.columns !== undefined)) {
    return 'count mode does not accept cursor, limit, or columns';
  }
  if (q.includeStatus && q.returnMode !== 'rows') return 'include_status works with return_mode rows only';
  return null;
}

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
  const out = await runQuery(sheetId, userId, viewed.query);
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
  if (q.includeStatus) {
    const runs = prep.runColumns ?? sheetRunColumns(sheetId, userId, columns);
    for (const r of rows) (r as { data: unknown }).data = rowWithStatus(r.data, runs, q.columns);
  } else if (q.columns) {
    for (const r of rows) r.data = Object.fromEntries(q.columns.map(c => [c, cellOf(r.data, c)]));
  }
  return { ok: { rows, next_cursor, ...versions } };
}
