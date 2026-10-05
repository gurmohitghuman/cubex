import { db } from '../lib/db';
import { getSheetColumns, parseRowData } from '../lib/sql-helpers';
import { passesCondition, type TextConditionOp } from '../lib/row-conditions';

// Row filters take the flow condition grammar plus numeric comparisons.
// Numeric ops are row-query-only: flow step conditions keep their own grammar.
export const NUMERIC_ROW_OPS = ['gt', 'gte', 'lt', 'lte'] as const;
export type RowConditionOp = TextConditionOp | (typeof NUMERIC_ROW_OPS)[number];
export const ROW_CONDITION_OPS: readonly RowConditionOp[] =
  ['eq', 'neq', 'contains', 'empty', 'not_empty', ...NUMERIC_ROW_OPS];

export interface RowCondition {
  column: string;
  operator: RowConditionOp;
  value?: string;
}

// Strict numeric parse: trimmed, non-empty, finite. '' and 'N/A' are NOT
// numbers (Number('') === 0 would silently match gt/lt filters).
const asNumber = (raw: string | undefined): number | null => {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
};

export interface RowQuery {
  after: number;
  limit?: number;
  columns?: string[];
  where?: RowCondition[];
  returnMode: 'rows' | 'ids' | 'count';
  expectedDataVersion?: number;
  expectedRowGeneration?: number;
}

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
  if (b.expected_data_version !== undefined && !int(b.expected_data_version)) return { error: 'Invalid expected_data_version.' };
  if (b.expected_row_generation !== undefined && !int(b.expected_row_generation)) return { error: 'Invalid expected_row_generation.' };
  if (b.columns !== undefined && (!Array.isArray(b.columns) || b.columns.length === 0
      || b.columns.some(c => typeof c !== 'string'))) return { error: 'columns must be a non-empty string array.' };
  const operators = new Set(ROW_CONDITION_OPS as readonly string[]);
  if (b.where !== undefined) {
    if (!Array.isArray(b.where) || b.where.length === 0) return { error: 'where must be a non-empty array of conditions.' };
    for (const c of b.where) {
      if (!c || typeof c !== 'object' || Array.isArray(c) || typeof c.column !== 'string') {
        return { error: 'Each where condition is an object with a column name, e.g. {"column":"Status","operator":"eq","value":"Done"}.' };
      }
      if (!operators.has(String(c.operator))) {
        return { error: `Unknown where operator "${String(c.operator)}". Use one of: ${ROW_CONDITION_OPS.join(', ')}.` };
      }
      if (c.value !== undefined && typeof c.value !== 'string') {
        return { error: 'where values are strings, numbers included (send "1000", not 1000).' };
      }
    }
  }
  if (b.return_mode !== undefined && !['rows', 'ids', 'count'].includes(String(b.return_mode))) {
    return { error: 'return_mode must be rows, ids, or count.' };
  }
  return { query: {
    after: (b.cursor as number | undefined) ?? -1,
    limit: b.limit as number | undefined,
    columns: b.columns as string[] | undefined,
    where: b.where as RowCondition[] | undefined,
    returnMode: (b.return_mode as RowQuery['returnMode']) ?? 'rows',
    expectedDataVersion: b.expected_data_version as number | undefined,
    expectedRowGeneration: b.expected_row_generation as number | undefined,
  } };
}

export function validateRowConditions(columns: string[], where: RowCondition[] = []): string | null {
  const known = new Set(columns);
  const unknown = where.map(w => w.column).filter(c => !known.has(c));
  if (unknown.length) return `Unknown column(s): ${[...new Set(unknown)].join(', ')}`;
  const numeric = new Set(NUMERIC_ROW_OPS as readonly string[]);
  for (const condition of where) {
    if (condition.operator === 'contains' && (condition.value ?? '') === '') return 'contains requires a non-empty value';
    if ((condition.operator === 'empty' || condition.operator === 'not_empty') && condition.value !== undefined) {
      return `${condition.operator} does not accept a value`;
    }
    if (!['empty', 'not_empty'].includes(condition.operator) && condition.value === undefined) {
      return `${condition.operator} requires a value`;
    }
    if (numeric.has(condition.operator) && asNumber(condition.value) === null) {
      return `${condition.operator} requires a numeric value`;
    }
  }
  return null;
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
  return validateRowConditions(columns, q.where);
}

// Own-property cell read: row data is plain JSON.parse output, so a sparse
// row's missing "constructor"/"toString" cell would otherwise resolve to the
// inherited prototype member (non-empty to filters, dropped by stringify).
export const cellOf = (data: Record<string, string>, column: string): string =>
  Object.prototype.hasOwnProperty.call(data, column) ? data[column] ?? '' : '';

export function rowPasses(data: Record<string, string>, where: RowCondition[] = []): boolean {
  return where.every(c => {
    const cell = cellOf(data, c.column);
    switch (c.operator) {
      // A cell that doesn't parse as a number never matches a numeric op
      // (documented: no lexicographic fallback — '10' < '9' surprises).
      case 'gt': { const n = asNumber(cell); return n !== null && n > Number(c.value); }
      case 'gte': { const n = asNumber(cell); return n !== null && n >= Number(c.value); }
      case 'lt': { const n = asNumber(cell); return n !== null && n < Number(c.value); }
      case 'lte': { const n = asNumber(cell); return n !== null && n <= Number(c.value); }
      default: return passesCondition(cell, c.operator, c.value ?? null);
    }
  });
}

export function queryRows(sheetId: string, userId: string, q: RowQuery): RowQueryResult {
  return db.transaction((): RowQueryResult => {
    const sheet = db.prepare(
      'SELECT data_version AS dv, row_generation AS rg FROM sheets WHERE id = ? AND user_id = ?',
    ).get(sheetId, userId) as { dv: number; rg: number } | undefined;
    if (!sheet) return { fail: 'invalid', error: 'Sheet not found' };
    const filtered = (q.where?.length ?? 0) > 0;
    if (q.expectedRowGeneration !== undefined && q.expectedRowGeneration !== sheet.rg) {
      return { fail: 'version_conflict', error: 'Sheet row order changed; restart paging.' };
    }
    if (filtered && q.after >= 0 && q.expectedDataVersion === undefined) {
      return { fail: 'invalid', error: 'Filtered paging after the first page requires expected_data_version.' };
    }
    if (filtered && q.after >= 0 && q.expectedRowGeneration === undefined) {
      return { fail: 'invalid', error: 'Filtered paging after the first page requires expected_row_generation.' };
    }
    if (q.expectedDataVersion !== undefined && q.expectedDataVersion !== sheet.dv) {
      return { fail: 'version_conflict', error: 'Sheet data changed; restart filtered paging.' };
    }
    const columns = getSheetColumns(sheetId, userId, false);
    const invalid = validateQuery(columns, q);
    if (invalid) return { fail: 'invalid', error: invalid };

    const raw = db.prepare(`
      SELECT id, row_index, data FROM rows
      WHERE sheet_id = ? AND user_id = ? AND row_index > ? ORDER BY row_index ASC
    `).iterate(sheetId, userId, q.after) as Iterable<{ id: string; row_index: number; data: string }>;
    let count = 0;
    const matches: Array<{ id: string; index: number; data: Record<string, string> }> = [];
    const wanted = q.returnMode === 'count' ? Infinity : (q.limit ?? 100) + 1;
    for (const row of raw) {
      const data = parseRowData(row.data);
      if (!rowPasses(data, q.where)) continue;
      count++;
      if (q.returnMode !== 'count' && matches.length < wanted) {
        const projected = q.columns
          ? Object.fromEntries(q.columns.map(c => [c, cellOf(data, c)]))
          : data;
        matches.push({ id: row.id, index: row.row_index, data: projected });
      }
      if (matches.length >= wanted) break;
    }
    const versions = { data_version: sheet.dv, row_generation: sheet.rg };
    if (q.returnMode === 'count') return { ok: { count, ...versions } };
    const hasMore = matches.length > (q.limit ?? 100);
    const page = hasMore ? matches.slice(0, q.limit ?? 100) : matches;
    const rows = q.returnMode === 'ids' ? page.map(({ id, index }) => ({ id, index })) : page;
    return {
      ok: {
        rows,
        next_cursor: hasMore ? page[page.length - 1].index : null,
        ...versions,
      },
    };
  })();
}
