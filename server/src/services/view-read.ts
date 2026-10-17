// Reading through a view (read_rows, REST rows/query, the exports): its
// filters become the `where` (ANDed with any `where` the caller adds) and,
// when it hides columns, its visible columns the columns (unless the caller
// names columns). The filters then go through the same checked SQL as any
// `where` (row-filter.ts). A view can change between pages (switched,
// filters edited) without the rows changing, so view reads answer a
// view_version that paging echoes back, like data_version.
import { createHash } from 'crypto';
import { getSheetColumns } from '../lib/sql-helpers';
import type { WhereItem } from '../lib/row-filter/where';
import { activeViewId, ensuredViewRows, sheetViewState, viewByRef, viewInfo, type ViewInfo } from './view-store';
import type { RowQuery } from './row-selection';

export interface ViewRead { view: ViewInfo; where: WhereItem[]; columns?: string[]; version: string }

// `ref`: a view's id or name, or "active" for the one the sheet shows.
export function viewForRead(sheetId: string, userId: string, ref: string): ViewRead | { error: string } | null {
  const state = sheetViewState(sheetId, userId);
  if (!state) return null;
  const rows = ensuredViewRows(sheetId, userId);
  const activeId = activeViewId(state, rows);
  const row = viewByRef(rows, ref, activeId);
  if (!row) {
    return { error: `No view "${ref}" on this sheet. Views: ${rows.map(r => `"${r.name}"`).join(', ')}.` };
  }
  const all = getSheetColumns(sheetId, userId, false);
  const view = viewInfo(row, state, activeId, new Set(all));
  const hidden = new Set(view.hidden_columns);
  const columns = hidden.size ? all.filter(c => !hidden.has(c)) : undefined;
  const version = createHash('sha256').update(JSON.stringify([view.id, view.where, view.hidden_columns]))
    .digest('hex').slice(0, 16);
  return { view, where: view.where, columns, version };
}

// A read's columns and `where` with a view applied (no view: as given).
export function applyView(
  sheetId: string, userId: string, view: string | undefined,
  query: { columns?: string[]; where?: WhereItem[] },
): { columns?: string[]; where?: WhereItem[]; version?: string } | { error: string } | null {
  if (view === undefined) return query;
  const read = viewForRead(sheetId, userId, view);
  if (!read || 'error' in read) return read;
  const where = [...read.where, ...(query.where ?? [])];
  return { columns: query.columns ?? read.columns, where: where.length ? where : undefined, version: read.version };
}

type QueryFail = { fail: 'invalid' | 'version_conflict'; error: string };

// A row query with its view's filters and columns in it (a count takes no
// columns), checked against the view_version a later page echoes.
export function withView(
  sheetId: string, userId: string, q: RowQuery,
): { query: RowQuery; version?: string } | QueryFail {
  if (q.view === undefined) return { query: q };
  const viewed = applyView(sheetId, userId, q.view, q);
  if (!viewed) return { fail: 'invalid', error: 'Sheet not found' };
  if ('error' in viewed) return { fail: 'invalid', error: viewed.error };
  if (q.after >= 0 && q.expectedViewVersion === undefined) {
    return { fail: 'invalid', error: 'Paging through a view after the first page requires expected_view_version.' };
  }
  if (q.expectedViewVersion !== undefined && q.expectedViewVersion !== viewed.version) {
    return { fail: 'version_conflict', error: 'The view changed (switched or its filters edited); restart paging.' };
  }
  const columns = q.returnMode === 'count' ? q.columns : viewed.columns;
  return { query: { ...q, where: viewed.where, columns }, version: viewed.version };
}
