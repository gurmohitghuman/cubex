// Saved views: create (a copy of another view, the active one by default),
// rename, describe, change filters or hidden columns, delete, and switch. One
// implementation for the app's routes and REST v1 (MCP only reads views).
// Storage and reads: view-store.ts. Hiding a column never touches rows or
// column_order; switching moves filters between the sheet and the view rows.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { MAX_VIEWS_PER_SHEET } from '../lib/constants-filters';
import type { ViewFilters } from '../lib/views/filters';
import { parseWhere, type WhereItem } from '../lib/row-filter/where';
import { bad, checkInput, checkViewWhere, isFail, notFound, taken, type ViewInput } from './view-input';
import {
  activeViewId, ensuredViewRows, filtersOf, findView, sheetViewState, viewInfo, viewRows,
  type ViewFail, type ViewInfo, type ViewRow,
} from './view-store';

// Any case, accents included (SQLite's LOWER, behind the unique index, folds ASCII only).
const nameTaken = (rows: readonly ViewRow[], name: string, exceptId: string): boolean =>
  rows.some(r => r.id !== exceptId && r.name.toLowerCase() === name.toLowerCase());

const setViewFilters = (userId: string, viewId: string, f: ViewFilters) =>
  db.prepare(`UPDATE sheet_views SET empty_filter = ?, column_filters = ?, row_filter = ?,
    updated_at = datetime('now') WHERE id = ? AND user_id = ?`)
    .run(f.empty_filter, f.column_filters, f.row_filter, viewId, userId);
const setSheetFilters = (sheetId: string, userId: string, f: ViewFilters) =>
  db.prepare(`UPDATE sheets SET empty_filter = ?, column_filters = ?, row_filter = ?,
    updated_at = datetime('now') WHERE id = ? AND user_id = ?`)
    .run(f.empty_filter, f.column_filters, f.row_filter, sheetId, userId);
const NO_FILTERS: ViewFilters = { empty_filter: null, column_filters: null, row_filter: null };

// Write a view's filters where they live: on the sheet while it is active.
function writeFilters(sheetId: string, userId: string, viewId: string, active: boolean, f: ViewFilters): void {
  if (active) setSheetFilters(sheetId, userId, f);
  else setViewFilters(userId, viewId, f);
}

// Switch inside a transaction: the sheet's filters go back to the view that
// was active, the new view's come onto the sheet (its own row then holds none).
function switchTo(sheetId: string, userId: string, target: ViewRow, currentId: string | null): void {
  if (currentId === target.id) return;
  const state = sheetViewState(sheetId, userId)!;
  if (currentId) setViewFilters(userId, currentId, state);
  setSheetFilters(sheetId, userId, target);
  setViewFilters(userId, target.id, NO_FILTERS);
  db.prepare('UPDATE sheets SET active_view_id = ? WHERE id = ? AND user_id = ?').run(target.id, sheetId, userId);
}

function result(sheetId: string, userId: string, id: string, columns: readonly string[]): ViewInfo {
  const state = sheetViewState(sheetId, userId)!;
  const rows = viewRows(sheetId, userId);
  return viewInfo(rows.find(r => r.id === id)!, state, activeViewId(state, rows), new Set(columns));
}

export type ViewOutcome = { ok: ViewInfo } | ViewFail;

// A new view: a copy of `from` (a view id or name; the active view when left
// out), then any name, description, where or hidden_columns given.
export function createView(
  sheetId: string, userId: string, input: ViewInput & { from?: unknown; activate?: boolean },
): ViewOutcome {
  const state = sheetViewState(sheetId, userId);
  if (!state) return notFound('Sheet');
  const columns = getSheetColumns(sheetId, userId, false);
  const checked = checkInput(sheetId, userId, { ...input, name: input.name ?? '' }, columns);
  if (isFail(checked)) return checked;
  const id = uuidv4();
  let fail: ViewFail | null = null;
  db.transaction(() => {
    const rows = ensuredViewRows(sheetId, userId);
    const activeId = activeViewId(sheetViewState(sheetId, userId)!, rows);
    if (rows.length >= MAX_VIEWS_PER_SHEET) {
      fail = bad(`A sheet can have at most ${MAX_VIEWS_PER_SHEET} views. Delete one first.`);
      return;
    }
    if (input.from !== undefined && typeof input.from !== 'string') {
      fail = bad('from is a view name or id.');
      return;
    }
    const source = input.from === undefined ? rows.find(r => r.id === activeId) : findView(rows, input.from);
    if (!source) { fail = notFound(); return; }
    if (nameTaken(rows, checked.name!, '')) { fail = taken(checked.name!); return; }
    const filters = checked.filters ?? filtersOf(source, sheetViewState(sheetId, userId)!, activeId);
    const hidden = checked.hidden !== undefined ? checked.hidden : source.hidden_columns;
    const position = Math.max(0, ...rows.map(r => r.position)) + 1;
    db.prepare(`INSERT INTO sheet_views (id, sheet_id, user_id, name, description, empty_filter, column_filters,
        row_filter, hidden_columns, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, sheetId, userId, checked.name, checked.description ?? null, filters.empty_filter,
        filters.column_filters, filters.row_filter, hidden, position);
    if (input.activate) switchTo(sheetId, userId, viewRows(sheetId, userId).find(r => r.id === id)!, activeId);
  }).immediate();
  return fail ?? { ok: result(sheetId, userId, id, columns) };
}

// Rename, describe, change filters or hidden columns: only what's given.
export function updateView(sheetId: string, userId: string, ref: string, input: ViewInput): ViewOutcome {
  const state = sheetViewState(sheetId, userId);
  if (!state) return notFound('Sheet');
  const columns = getSheetColumns(sheetId, userId, false);
  const checked = checkInput(sheetId, userId, input, columns);
  if (isFail(checked)) return checked;
  let fail: ViewFail | null = null;
  let id = '';
  db.transaction(() => {
    const rows = ensuredViewRows(sheetId, userId);
    const view = findView(rows, ref);
    if (!view) { fail = notFound(); return; }
    id = view.id;
    if (checked.name !== undefined && nameTaken(rows, checked.name, view.id)) {
      fail = taken(checked.name);
      return;
    }
    db.prepare(`UPDATE sheet_views SET name = ?, description = ?, hidden_columns = ?, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?`).run(checked.name ?? view.name,
      checked.description !== undefined ? checked.description : view.description,
      checked.hidden !== undefined ? checked.hidden : view.hidden_columns, view.id, userId);
    if (checked.filters) {
      const active = activeViewId(sheetViewState(sheetId, userId)!, rows) === view.id;
      writeFilters(sheetId, userId, view.id, active, checked.filters);
    }
  }).immediate();
  return fail ?? { ok: result(sheetId, userId, id, columns) };
}

// The Default view can't be deleted; deleting the active view switches the
// sheet to the Default view first.
export function deleteView(sheetId: string, userId: string, ref: string): { ok: true } | ViewFail {
  if (!sheetViewState(sheetId, userId)) return notFound('Sheet');
  let fail: ViewFail | null = null;
  db.transaction(() => {
    const rows = ensuredViewRows(sheetId, userId);
    const view = findView(rows, ref);
    if (!view) { fail = notFound(); return; }
    if (view.is_default) { fail = bad("The Default view can't be deleted."); return; }
    if (activeViewId(sheetViewState(sheetId, userId)!, rows) === view.id) {
      switchTo(sheetId, userId, rows.find(r => r.is_default)!, view.id);
    }
    db.prepare('DELETE FROM sheet_views WHERE id = ? AND user_id = ?').run(view.id, userId);
  }).immediate();
  return fail ?? { ok: true };
}

export function activateView(sheetId: string, userId: string, ref: string): ViewOutcome {
  if (!sheetViewState(sheetId, userId)) return notFound('Sheet');
  let fail: ViewFail | null = null;
  let id = '';
  db.transaction(() => {
    const rows = ensuredViewRows(sheetId, userId);
    const view = findView(rows, ref);
    if (!view) { fail = notFound(); return; }
    id = view.id;
    const activeId = activeViewId(sheetViewState(sheetId, userId)!, rows);
    if (activeId !== view.id) switchTo(sheetId, userId, view, activeId);
  }).immediate();
  return fail ?? { ok: result(sheetId, userId, id, getSheetColumns(sheetId, userId, false)) };
}


// The active view's row_filter alone (the app's "clear" on it): null, or a
// `where` kept whole, checked against the sheet.
export function saveRowFilter(sheetId: string, userId: string, raw: unknown): { ok: true } | ViewFail {
  if (!sheetViewState(sheetId, userId)) return notFound('Sheet');
  let stored: string | null = null;
  if (raw !== null && !(Array.isArray(raw) && raw.length === 0)) {
    const checked = checkViewWhere(sheetId, userId, raw, getSheetColumns(sheetId, userId, false));
    if (isFail(checked)) return checked;
    stored = JSON.stringify((parseWhere(raw) as { where: WhereItem[] }).where);
  }
  db.prepare("UPDATE sheets SET row_filter = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .run(stored, sheetId, userId);
  return { ok: true };
}
