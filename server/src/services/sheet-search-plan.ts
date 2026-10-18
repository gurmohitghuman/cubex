// What one search reads (services/sheet-search.ts): the sheet's active view
// (its filters pick the rows, its hidden columns aren't searched), the columns
// in the grid's order, and the SQL that drops rows which can't match before
// any row is read in JavaScript (lib/sheet-search/needle.ts).
import { db } from '../lib/db';
import { jsonPath } from '../lib/json-path';
import { getSheetColumns } from '../lib/sql-helpers';
import { fillingColumns } from '../lib/field-fill-columns';
import { MAX_SEARCH_CHARS } from '../lib/constants-query';
import { cellMatches, foldNeedle, likePattern, likePiece } from '../lib/sheet-search/needle';
import { compileWhere, type CompiledFilter } from '../lib/row-filter/sql';
import { readsRunState } from '../lib/views/filters';
import { sheetRunColumns } from './row-filter';
import { listViews } from './view-store';

export interface SearchPlan {
  needle: string;
  // Every column in the grid's order, and the ones searched (not hidden, not filling).
  columns: string[];
  searched: string[];
  // The active view's filters (null: every row) and the rows that might match.
  filter: CompiledFilter | null;
  prefilter: CompiledFilter;
  versions: { data_version: number; row_generation: number };
}

export type PlanFail = { fail: 'invalid' | 'not_found' | 'view_changed'; error: string };

// LIKE on the row's JSON, then on each searched column's value (a column name
// alone matching would pass every row). Text LIKE can't look for ("москва",
// "ß" alone) is folded in JavaScript, the whole row's JSON once (it has no
// character JSON escapes, or a piece would exist), then each column. Whether
// Σ lower-cases to σ or ς depends on its neighbours, and an escape in the JSON
// ("\n" before it) changes them, so that check reads every ς as σ, on both sides.
const FINAL_SIGMA = /\u03c2/g;
export function prefilterSql(needle: string, searched: readonly string[]): CompiledFilter {
  if (searched.length === 0) return { sql: '0', params: [] };
  const parts: string[] = [], params: unknown[] = [];
  const inJson = likePiece(needle, true);
  const inCell = likePiece(needle, false);
  if (inJson) { parts.push("data LIKE ? ESCAPE '\\'"); params.push(likePattern(inJson)); }
  if (!inCell) {
    parts.push('instr(replace(cubex_fold(data), char(962), char(963)), ?) > 0');
    params.push(needle.replace(FINAL_SIGMA, '\u03c3'));
  }
  const each = searched.map(c => {
    params.push(jsonPath(c), inCell ? likePattern(inCell) : needle);
    return inCell ? "json_extract(data, ?) LIKE ? ESCAPE '\\'" : 'instr(cubex_fold(json_extract(data, ?)), ?) > 0';
  });
  parts.push(each.length === 1 ? each[0] : `(${each.join(' OR ')})`);
  return { sql: parts.join(' AND '), params };
}

export function planSearch(sheetId: string, userId: string, q: unknown, viewId: unknown): SearchPlan | PlanFail {
  if (typeof q !== 'string' || !foldNeedle(q)) return { fail: 'invalid', error: 'Type something to search for.' };
  if (q.length > MAX_SEARCH_CHARS) {
    return { fail: 'invalid', error: `Search for at most ${MAX_SEARCH_CHARS} characters.` };
  }
  const versions = db.prepare(`SELECT data_version, row_generation FROM sheets WHERE id = ? AND user_id = ?
    AND trash_id IS NULL`).get(sheetId, userId) as SearchPlan['versions'] | undefined;
  if (!versions) return { fail: 'not_found', error: 'Sheet not found' };
  const columns = getSheetColumns(sheetId, userId, false);
  // The active view's filters and hidden columns, read together.
  const active = (listViews(sheetId, userId, columns) ?? []).find(v => v.active);
  if (typeof viewId === 'string' && viewId && active && active.id !== viewId) {
    return { fail: 'view_changed', error: 'Another view is showing now. Reloading.' };
  }
  const where = active?.where ?? [];
  const runs = readsRunState(where) ? sheetRunColumns(sheetId, userId, columns) : new Map<string, string>();
  const skip = new Set([...(active?.hidden_columns ?? []), ...fillingColumns(sheetId, userId)]);
  const searched = columns.filter(c => !skip.has(c));
  const needle = foldNeedle(q);
  return {
    needle, columns, searched,
    filter: where.length ? compileWhere(where, runs) : null,
    prefilter: prefilterSql(needle, searched),
    versions,
  };
}

// The searched columns of one row, in the order a search visits them, as
// indexes into plan.columns. Around the row a search starts from (`at`, the
// index of its column), only the side `side` asks for: after, before, or up
// to and including it.
export type Side = 'after' | 'from' | 'before' | 'to';
export function rowColumns(plan: SearchPlan, back: boolean, at?: { index: number; side: Side }): number[] {
  const order = plan.searched.map(c => plan.columns.indexOf(c));
  const kept = !at ? order : order.filter(i => (at.side === 'after' ? i > at.index : at.side === 'from'
    ? i >= at.index : at.side === 'before' ? i < at.index : i <= at.index));
  return back ? kept.reverse() : kept;
}

// The first matching column (an index into plan.columns) among `order`, or -1.
export function firstHit(plan: SearchPlan, data: string, order: readonly number[]): number {
  let row: Record<string, unknown>;
  try { row = JSON.parse(data); } catch { return -1; }
  for (const i of order) {
    const column = plan.columns[i];
    if (Object.prototype.hasOwnProperty.call(row, column) && cellMatches(row[column], plan.needle)) return i;
  }
  return -1;
}

// How many of `order` match.
export function hitCount(plan: SearchPlan, data: string, order: readonly number[]): number {
  let row: Record<string, unknown>;
  try { row = JSON.parse(data); } catch { return 0; }
  let n = 0;
  for (const i of order) {
    const column = plan.columns[i];
    if (Object.prototype.hasOwnProperty.call(row, column) && cellMatches(row[column], plan.needle)) n++;
  }
  return n;
}
