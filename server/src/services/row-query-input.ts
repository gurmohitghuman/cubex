// What a row query asks for (read_rows and /api/v1 rows/query): the REST body
// read and checked, and the checks both surfaces share once the sheet's
// columns are known. services/row-selection.ts runs it.
import { parseWhere, type WhereItem } from '../lib/row-filter/where';
import { parseColumns, type ColumnPick } from '../lib/row-select/paths';
import { checkAggregate, parseAggregate, type AggregateSpec } from '../lib/row-aggregate/spec';
import { SINCE_FORMAT_HELP } from '../lib/row-since';
import { ROWS_BY_ID_MAX } from '../lib/api-v1-constants';
import { CELL_CUT_MAX_CHARS, CELL_CUT_MIN_CHARS } from '../lib/constants-query';
import { digitsAsNumber } from '../lib/digits-text';

export interface RowQuery {
  after: number;
  limit?: number;
  // The columns read, once each (with picks: the columns the picks read).
  columns?: string[];
  // Set when `columns` takes values out of JSON cells or renames: what each
  // returned key holds (lib/row-select/paths.ts).
  picks?: ColumnPick[];
  where?: WhereItem[];
  returnMode: 'rows' | 'ids' | 'count';
  // Run columns' cells as {status, value, error} (lib/row-filter/status-rows.ts).
  includeStatus?: boolean;
  // group_by / aggregates: groups instead of rows (lib/row-aggregate).
  aggregate?: AggregateSpec;
  expectedDataVersion?: number;
  expectedRowGeneration?: number;
  // A saved view (id or name): its filters are ANDed with `where`, its visible
  // columns are the columns unless `columns` names them (services/view-read.ts).
  view?: string;
  // Paging through a view: the view_version the previous page answered.
  expectedViewVersion?: string;
  // Set by view-read.ts withView, never parsed from a request: the view's own
  // filter inside `where` (row-filter.ts prepareWhere's `saved`).
  viewWhere?: WhereItem[];
  // Exactly these rows, by stable id, in this order (services/rows-by-id.ts).
  rowIds?: string[];
  // Rows whose cells changed at or after this time, as asked (services/rows-since.ts
  // reads it), and the text cursor of that walk.
  updatedSince?: string;
  sinceCursor?: string;
  // Set by MCP, never parsed from a request: a read by id stops adding rows past
  // about this many characters and lists the rest in unread_ids.
  maxChars?: number;
  // max_chars_per_cell: each returned cell's text cut to this many characters,
  // the cells cut listed in cut_cells (services/row-project.ts cutRows).
  maxCharsPerCell?: number;
}

// max_chars_per_cell as either surface sends it. null = fine (or not sent).
// MCP's schema refuses with the same words (mcp/query-schema.ts).
export const CELL_CUT_REFUSAL =
  `max_chars_per_cell must be an integer from ${CELL_CUT_MIN_CHARS} to ${CELL_CUT_MAX_CHARS}.`;
export function checkMaxChars(v: unknown): string | null {
  if (v === undefined) return null;
  if (typeof v === 'number' && Number.isInteger(v) && v >= CELL_CUT_MIN_CHARS && v <= CELL_CUT_MAX_CHARS) return null;
  return CELL_CUT_REFUSAL;
}

export function parseRowQueryBody(
  body: unknown, maxLimit: number,
): { query: RowQuery } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Request body must be an object.' };
  const b = body as Record<string, unknown>;
  const int = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  // A text cursor is an updated_since walk's (checked with it, in checkPickedQuery).
  // A string of digits is a row index sent as text: refused, as before text
  // cursors existed (MCP reads it as the number: mcp/tools-read.ts).
  const textCursor = typeof b.cursor === 'string' && b.cursor !== '' && !/^\s*\d+\s*$/.test(b.cursor);
  if (b.cursor !== undefined && !int(b.cursor) && !textCursor) {
    return { error: 'cursor must be a non-negative integer, or the next_cursor of an updated_since read.' };
  }
  if (b.row_ids !== undefined && (!Array.isArray(b.row_ids) || !b.row_ids.every(id => typeof id === 'string'))) {
    return { error: 'row_ids must be a list of row ids.' };
  }
  if (b.updated_since !== undefined && typeof b.updated_since !== 'string') return { error: SINCE_FORMAT_HELP };
  if (b.limit !== undefined && (!int(b.limit) || b.limit === 0 || (b.limit as number) > maxLimit)) {
    return { error: `limit must be an integer from 1 to ${maxLimit}.` };
  }
  if (b.expected_data_version !== undefined && !int(b.expected_data_version)) {
    return { error: 'Invalid expected_data_version.' };
  }
  if (b.expected_row_generation !== undefined && !int(b.expected_row_generation)) {
    return { error: 'Invalid expected_row_generation.' };
  }
  let columns: { names: string[]; picks: ColumnPick[] | null } | undefined;
  if (b.columns !== undefined) {
    const parsed = parseColumns(b.columns);
    if ('error' in parsed) return { error: parsed.error };
    columns = parsed;
  }
  let where: WhereItem[] | undefined;
  if (b.where !== undefined) {
    const parsed = parseWhere(b.where);
    if ('error' in parsed) return { error: parsed.error };
    where = parsed.where;
  }
  const aggregate = parseAggregate(b.group_by, b.aggregates);
  if ('error' in aggregate) return { error: aggregate.error };
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
  // Digits sent as text are the number, as over MCP (lib/digits-text.ts).
  const maxCharsPerCell = digitsAsNumber(b.max_chars_per_cell);
  const cutProblem = checkMaxChars(maxCharsPerCell);
  if (cutProblem) return { error: cutProblem };
  return { query: {
    after: typeof b.cursor === 'number' ? b.cursor : -1,
    ...(typeof b.cursor === 'string' ? { sinceCursor: b.cursor } : {}),
    ...(b.row_ids !== undefined ? { rowIds: b.row_ids as string[] } : {}),
    ...(b.updated_since !== undefined ? { updatedSince: b.updated_since as string } : {}),
    limit: b.limit as number | undefined,
    columns: columns?.names,
    ...(columns?.picks ? { picks: columns.picks } : {}),
    where,
    returnMode: (b.return_mode as RowQuery['returnMode']) ?? 'rows',
    includeStatus: b.include_status === true,
    ...(aggregate.spec ? { aggregate: aggregate.spec } : {}),
    expectedDataVersion: b.expected_data_version as number | undefined,
    expectedRowGeneration: b.expected_row_generation as number | undefined,
    view: b.view as string | undefined,
    expectedViewVersion: b.expected_view_version as string | undefined,
    ...(maxCharsPerCell !== undefined ? { maxCharsPerCell: maxCharsPerCell as number } : {}),
  } };
}

// Against the sheet's columns. null = fine.
export function validateQuery(columns: string[], q: RowQuery): string | null {
  const known = new Set(columns);
  const unknown = (q.columns ?? []).filter(c => !known.has(c));
  if (unknown.length) return `Unknown column(s): ${[...new Set(unknown)].join(', ')}`;
  if (q.columns && !q.picks && new Set(q.columns).size !== q.columns.length) {
    return 'columns must not contain duplicates';
  }
  // max_chars_per_cell cuts rows' cells: groups (whose values are already cut to
  // GROUP_VALUE_MAX_CHARS) and ids or counts have none. Named in the first
  // refusal when sent (a count's with include_status too, when that is sent),
  // so one change of the call is enough.
  const cut = q.maxCharsPerCell !== undefined;
  if (q.aggregate) {
    if (q.after >= 0 || q.limit !== undefined || q.columns || q.returnMode !== 'rows' || q.includeStatus || cut) {
      return 'group_by and aggregates answer groups, not rows: leave out cursor, limit, columns, return_mode'
        + (cut ? ', include_status and max_chars_per_cell.' : ' and include_status.');
    }
    return checkAggregate(q.aggregate, columns);
  }
  if (q.returnMode === 'count' && (q.after >= 0 || q.limit !== undefined || q.columns !== undefined || cut)) {
    const also = !cut ? 'or columns' : `columns, ${q.includeStatus ? 'include_status, ' : ''}or max_chars_per_cell`;
    return `count mode does not accept cursor, limit, ${also}`;
  }
  if ((q.includeStatus || cut) && q.returnMode !== 'rows') {
    return q.includeStatus && cut ? 'include_status and max_chars_per_cell work with return_mode rows only'
      : `${cut ? 'max_chars_per_cell' : 'include_status'} works with return_mode rows only`;
  }
  return null;
}

// row_ids and updated_since: what each reads with, checked before anything is
// read. null = fine. A read by id names its rows, so it takes no filter, view,
// paging, limit or groups; a read by time pages with its own text cursor and
// `limit`. Neither takes the paging fences (expected_*): ids don't move, and
// rows changing during a walk by time is what it reads.
export function checkPickedQuery(q: RowQuery): string | null {
  const ids = q.rowIds !== undefined, since = q.updatedSince !== undefined;
  if (!ids && !since) {
    return q.sinceCursor === undefined ? null
      : 'This cursor is the next_cursor of an updated_since read: send it with the same updated_since.';
  }
  if (ids && since) return 'row_ids and updated_since are two different reads: pass one of them.';
  const fenced = q.expectedDataVersion !== undefined || q.expectedRowGeneration !== undefined
    || q.expectedViewVersion !== undefined;
  const extra = [
    (q.where?.length ?? 0) > 0 && 'where', q.view !== undefined && 'view',
    q.aggregate && 'group_by and aggregates', q.returnMode !== 'rows' && 'return_mode (it returns rows)',
    fenced && 'expected_data_version, expected_row_generation and expected_view_version',
    ids && (q.after >= 0 || q.sinceCursor !== undefined) && 'cursor', ids && q.limit !== undefined && 'limit',
    since && q.after >= 0 && 'a number cursor (pass next_cursor as it came)',
  ].filter((x): x is string => typeof x === 'string');
  if (ids) {
    const rowIds = q.rowIds!;
    if (rowIds.length === 0 || rowIds.length > ROWS_BY_ID_MAX) return `row_ids takes 1 to ${ROWS_BY_ID_MAX} row ids.`;
    if (rowIds.some(id => typeof id !== 'string' || id === '')) return 'row_ids must be a list of row ids.';
    if (new Set(rowIds).size !== rowIds.length) return 'row_ids must not name a row twice.';
    if (extra.length) return `row_ids reads exactly the rows it names: leave out ${extra.join(', ')}.`;
    return null;
  }
  if (extra.length) return `updated_since reads rows by when they changed: leave out ${extra.join(', ')}.`;
  return null;
}
