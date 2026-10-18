// Saved views' rows (migration 030): reading them, the Default view every
// sheet has, and which view is active. The active view's filters live on the
// sheet (sheets.empty_filter, column_filters, row_filter), every other view's
// on its own row; hidden_columns is always on the row. Mutations: views.ts.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import type { WhereItem } from '../lib/row-filter/where';
import { viewWhere, type ViewFilters } from '../lib/views/filters';
import { parseHiddenColumns } from '../lib/views/refs';

export const DEFAULT_VIEW_NAME = 'Default';

export interface ViewRow extends ViewFilters {
  id: string; name: string; description: string | null; is_default: number;
  hidden_columns: string | null; position: number; created_at: string; updated_at: string;
}
export interface SheetViewState extends ViewFilters { active_view_id: string | null }

export interface ViewInfo {
  id: string; name: string; description: string | null; is_default: boolean; active: boolean;
  // Live columns only, in no particular order.
  hidden_columns: string[];
  // Its filters as one `where` (lib/row-filter/where.ts); [] = every row.
  where: WhereItem[];
}

export type ViewFail = { fail: 'bad_request' | 'not_found' | 'conflict'; message: string };

export const sheetViewState = (sheetId: string, userId: string): SheetViewState | undefined =>
  db.prepare(`SELECT empty_filter, column_filters, row_filter, active_view_id FROM sheets WHERE id = ? AND user_id = ?
    AND trash_id IS NULL`).get(sheetId, userId) as SheetViewState | undefined;

export const viewRows = (sheetId: string, userId: string): ViewRow[] =>
  db.prepare(`SELECT id, name, description, is_default, empty_filter, column_filters, row_filter, hidden_columns,
      position, created_at, updated_at
    FROM sheet_views WHERE sheet_id = ? AND user_id = ? ORDER BY is_default DESC, position, created_at, name`)
    .all(sheetId, userId) as ViewRow[];

// A new sheet's Default view, made active. Call inside the transaction that
// inserts the sheet.
export function createDefaultView(sheetId: string, userId: string): string {
  const id = uuidv4();
  db.prepare(`INSERT INTO sheet_views (id, sheet_id, user_id, name, is_default, position)
    VALUES (?, ?, ?, ?, 1, 0)`).run(id, sheetId, userId, DEFAULT_VIEW_NAME);
  db.prepare('UPDATE sheets SET active_view_id = ? WHERE id = ? AND user_id = ?').run(id, sheetId, userId);
  return id;
}

// The views, with a Default one made first if the sheet somehow has none.
export function ensuredViewRows(sheetId: string, userId: string): ViewRow[] {
  const rows = viewRows(sheetId, userId);
  if (rows.some(r => r.is_default)) return rows;
  db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM sheet_views WHERE sheet_id = ? AND user_id = ? AND is_default = 1')
      .get(sheetId, userId)) {
      const taken = db.prepare(
        'SELECT 1 FROM sheet_views WHERE sheet_id = ? AND user_id = ? AND LOWER(name) = LOWER(?)',
      ).get(sheetId, userId, DEFAULT_VIEW_NAME);
      const id = uuidv4();
      db.prepare(`INSERT INTO sheet_views (id, sheet_id, user_id, name, is_default, position)
        VALUES (?, ?, ?, ?, 1, 0)`).run(id, sheetId, userId, taken ? `${DEFAULT_VIEW_NAME} view` : DEFAULT_VIEW_NAME);
      if (!rows.length) {
        db.prepare('UPDATE sheets SET active_view_id = ? WHERE id = ? AND user_id = ?').run(id, sheetId, userId);
      }
    }
  }).immediate();
  return viewRows(sheetId, userId);
}

// The active view's id: the sheet's pointer when it names one of its views,
// else the Default view.
export function activeViewId(state: SheetViewState, rows: readonly ViewRow[]): string | null {
  if (state.active_view_id && rows.some(r => r.id === state.active_view_id)) return state.active_view_id;
  return rows.find(r => r.is_default)?.id ?? null;
}

// A view's filters: the sheet's when it is the active one.
export const filtersOf = (row: ViewRow, state: SheetViewState, activeId: string | null): ViewFilters =>
  row.id === activeId ? state : row;

export function viewInfo(
  row: ViewRow, state: SheetViewState, activeId: string | null, live: ReadonlySet<string>,
): ViewInfo {
  return {
    id: row.id, name: row.name, description: row.description, is_default: !!row.is_default,
    active: row.id === activeId,
    hidden_columns: parseHiddenColumns(row.hidden_columns).filter(c => live.has(c)),
    where: viewWhere(filtersOf(row, state, activeId)),
  };
}

// Every view of a sheet, Default first; null when the sheet isn't found.
export function listViews(sheetId: string, userId: string, columns?: readonly string[]): ViewInfo[] | null {
  const state = sheetViewState(sheetId, userId);
  if (!state) return null;
  const rows = ensuredViewRows(sheetId, userId);
  const activeId = activeViewId(state, rows);
  const live = new Set(columns ?? getSheetColumns(sheetId, userId, false));
  return rows.map(r => viewInfo(r, state, activeId, live));
}

// A view by id, or by name (any case): how the API names one.
export function findView(rows: readonly ViewRow[], ref: string): ViewRow | undefined {
  return rows.find(r => r.id === ref) ?? rows.find(r => r.name.toLowerCase() === ref.trim().toLowerCase());
}

// A view as reads name it: an id, a name, or "active" (the one the app shows,
// unless a view is named "active").
export function viewByRef(rows: readonly ViewRow[], ref: string, activeId: string | null): ViewRow | undefined {
  const named = findView(rows, ref);
  if (named || ref.trim().toLowerCase() !== 'active') return named;
  return rows.find(r => r.id === activeId);
}

// A filter save that names the view it was made in, when another one is
// active now (switched in another tab): saving it would change the wrong view.
export function viewMoved(sheetId: string, userId: string, viewId: unknown): boolean {
  if (typeof viewId !== 'string') return false;
  const state = sheetViewState(sheetId, userId);
  return !!state && activeViewId(state, viewRows(sheetId, userId)) !== viewId;
}
