// Writing a sheet out as CSV a page of rows at a time, yielding to other
// requests between pages: the UI and /api/v1 downloads (lib/csv-export.ts) and
// one-time download links (routes/file-links.ts). Same columns, escaping, row
// order and line breaks as buildSheetCsv. escapeCsvCell neutralizes formula
// injection, at the boundary where it matters: the spreadsheet app the file is
// opened in.
import type { Response } from 'express';
import { db } from './db';
import { parseRowData } from './sql-helpers';
import { escapeCsvCell } from './csv-safety';
import { yieldToRequests } from './slices';
import type { CompiledFilter } from './row-filter/sql';

// What an export writes (lib/csv-export.ts planSheetExport builds it): the
// rows passing `filter`, the `where` read_rows takes compiled to SQL.
export interface SheetExportPlan { sheetName: string; columns: string[]; filter?: CompiledFilter }

const EXPORT_PAGE_ROWS = 5_000;

// One row as a CSV line, escaped the same way in every export.
export const csvLine = (columns: string[], data: Record<string, string>): string =>
  columns.map(col => escapeCsvCell(data[col] ?? '')).join(',');

// The sheet's row data in row order, EXPORT_PAGE_ROWS rows at a time,
// yielding to other requests between pages, until `apply` returns false. With
// a filter, a row it leaves out comes as null: SQLite checks it, and a page
// still reads EXPORT_PAGE_ROWS rows however few pass, so no page holds the
// server for long.
export async function eachPage(
  sheetId: string, userId: string, apply: (rows: Array<string | null>) => boolean | Promise<boolean>,
  filter?: CompiledFilter,
): Promise<void> {
  const page = db.prepare(`
    SELECT row_index, ${filter ? `CASE WHEN ${filter.sql} THEN data END` : 'data'} FROM rows
    WHERE sheet_id = ? AND user_id = ? AND row_index > ? ORDER BY row_index LIMIT ?
  `).raw();
  const params = filter?.params ?? [];
  for (let after = Number.MIN_SAFE_INTEGER; ;) {
    const rows = page.all(...params, sheetId, userId, after, EXPORT_PAGE_ROWS) as Array<[number, string | null]>;
    if (!(await apply(rows.map(r => r[1]))) || rows.length < EXPORT_PAGE_ROWS) return;
    after = rows[rows.length - 1][0];
    await yieldToRequests();
  }
}

// The header, then each page's matching rows as one chunk, handed to `write`,
// which says whether to go on. Returns how many rows went out.
export async function writeSheetCsv(
  sheetId: string, userId: string, plan: SheetExportPlan, write: (chunk: string) => Promise<boolean>,
): Promise<number> {
  let chunk = plan.columns.map(escapeCsvCell).join(',');
  let rowCount = 0;
  await eachPage(sheetId, userId, async rows => {
    for (const json of rows) {
      if (json === null) continue;
      chunk += '\r\n' + csvLine(plan.columns, parseRowData(json));
      rowCount++;
    }
    const more = await write(chunk);
    chunk = '';
    return more;
  }, plan.filter);
  return rowCount;
}

// `write` for an HTTP response: it waits while the client is behind, and stops
// once the client has gone.
export function responseWriter(res: Response): (chunk: string) => Promise<boolean> {
  return async chunk => {
    if (res.destroyed) return false;
    if (!res.write(chunk)) await drained(res);
    return !res.destroyed;
  };
}

// Resolves when the client has taken the buffered output, or has gone away.
function drained(res: Response): Promise<void> {
  return new Promise(resolve => {
    if (res.destroyed) return resolve();
    const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
    res.on('drain', done);
    res.on('close', done);
  });
}
