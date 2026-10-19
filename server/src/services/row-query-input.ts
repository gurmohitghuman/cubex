// What a row query asks for (read_rows and /api/v1 rows/query): the REST body
// read and checked, and the checks both surfaces share once the sheet's
// columns are known. services/row-selection.ts runs it.
import { parseWhere, type WhereItem } from '../lib/row-filter/where';
import { parseColumns, type ColumnPick } from '../lib/row-select/paths';
import { checkAggregate, parseAggregate, type AggregateSpec } from '../lib/row-aggregate/spec';

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
}

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
  return { query: {
    after: (b.cursor as number | undefined) ?? -1,
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
  if (q.aggregate) {
    if (q.after >= 0 || q.limit !== undefined || q.columns || q.returnMode !== 'rows' || q.includeStatus) {
      return 'group_by and aggregates answer groups, not rows: leave out cursor, limit, columns, return_mode and '
        + 'include_status.';
    }
    return checkAggregate(q.aggregate, columns);
  }
  if (q.returnMode === 'count' && (q.after >= 0 || q.limit !== undefined || q.columns !== undefined)) {
    return 'count mode does not accept cursor, limit, or columns';
  }
  if (q.includeStatus && q.returnMode !== 'rows') return 'include_status works with return_mode rows only';
  return null;
}
