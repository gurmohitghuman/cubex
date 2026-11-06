// A row query's rows as it asked for them (read_rows and REST rows/query:
// pages, filtered pages, reads by id and by time): cells parsed, a column still
// filling reads "⏳ Processing..." (except in a read by time, which answers what
// rows hold: services/rows-since.ts), the columns named or picked, and with
// include_status run columns as {status, value, error}.
import { db } from '../lib/db';
import { parseRowData } from '../lib/sql-helpers';
import { cellOf } from '../lib/row-cell';
import { fillingColumns, overlayFilling } from '../lib/field-fill-columns';
import { rowWithStatus } from '../lib/row-filter/status-rows';
import { pickName, pickValue } from '../lib/row-select/paths';
import type { RunColumnMap } from '../lib/row-filter/sql';
import { staleByRow } from './run-status-rows';
import type { RowQuery } from './row-query-input';

export type PageRow = { id: string; row_index: number; data: string };
export type ShapedRow = { id: string; index: number; data: Record<string, unknown> };
// Run column → the column holding its run's state (services/row-filter.ts sheetRunColumns).
type RunColumns = RunColumnMap;

export type Versions = { data_version: number; row_generation: number };
export const versionsOf = (sheetId: string, userId: string) => db.prepare(
  'SELECT data_version, row_generation FROM sheets WHERE id = ? AND user_id = ?',
).get(sheetId, userId) as Versions | undefined;

// runs: the sheet's run columns when include_status asked, else null.
// errors: row id → state column → the full error text its run recorded
// (services/run-cell-errors.ts), for the cells that read as failed.
// stored: the cells as rows hold them, with no "⏳ Processing..." over a
// column still filling (a read by time: a fill stamps only the rows it
// changes, so a placeholder answered there would never be answered again).
export interface ShapeOptions {
  errors?: ReadonlyMap<string, ReadonlyMap<string, string>>;
  stored?: boolean;
}

export function shapeRows(
  sheetId: string, userId: string, page: PageRow[], q: RowQuery, runs: RunColumns | null, opts: ShapeOptions = {},
): ShapedRow[] {
  const rows = page.map(r => ({ id: r.id, index: r.row_index, data: parseRowData(r.data) }));
  if (!opts.stored) overlayFilling(rows, fillingColumns(sheetId, userId));
  const stale = runs ? staleByRow(sheetId, userId, rows.map(r => r.id), runs) : null;
  for (const r of rows) {
    (r as ShapedRow).data = projectRow(r.data, q, runs, stale?.get(r.id), opts.errors?.get(r.id));
  }
  return rows;
}

// A row's data as the query asked: every column, the columns named, or picks
// (a value out of a JSON cell, a column under another name); run columns as
// {status, value, error} with include_status.
function projectRow(
  data: Record<string, string>, q: RowQuery, runs: RunColumns | null, stale?: ReadonlySet<string>,
  errors?: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const plain = runs ? rowWithStatus(data, runs, q.columns, stale, errors) : null;
  if (!q.picks) {
    if (plain) return plain;
    return q.columns ? Object.fromEntries(q.columns.map(c => [c, cellOf(data, c)])) : data;
  }
  return Object.fromEntries(q.picks.map(p => [pickName(p),
    p.path ? pickValue(cellOf(data, p.column), p.path) : plain ? plain[p.column] : cellOf(data, p.column)]));
}
