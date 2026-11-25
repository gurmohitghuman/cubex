// Writing a sheet out as CSV (or JSON lines: writeSheetJsonl) a page of rows at a time, yielding to other
// requests between pages: the UI and /api/v1 downloads (lib/csv-export.ts) and
// one-time download links (routes/file-links.ts). Same columns, escaping, row
// order and line breaks as buildSheetCsv. escapeCsvCell neutralizes formula
// injection, at the boundary where it matters: the spreadsheet app the file is
// opened in.
import type { Response } from 'express';
import { db } from './db';
import { parseRowData } from './sql-helpers';
import { escapeCsvCell } from './csv-safety';
import { cellOf } from './row-cell';
import { yieldToRequests } from './slices';
import type { CompiledFilter } from './row-filter/sql';

// What an export writes (lib/csv-export.ts planSheetExport builds it): the
// rows passing `filter`, the `where` read_rows takes compiled to SQL.
export interface SheetExportPlan { sheetName: string; columns: string[]; filter?: CompiledFilter }

const EXPORT_PAGE_ROWS = 5_000;

// One row as a CSV line, escaped the same way in every export. A row without a
// column's key has an empty cell there, also for a column named like a member
// every object inherits ("constructor"), whose inherited value must not be read.
export const csvLine = (columns: string[], data: Record<string, string>): string =>
  columns.map(col => escapeCsvCell(cellOf(data, col))).join(',');

// The sheet's row data in row order, EXPORT_PAGE_ROWS rows at a time,
// yielding to other requests between pages, until `apply` returns false. With
// a filter, a row it leaves out comes as null: SQLite checks it, and a page
// still reads EXPORT_PAGE_ROWS rows however few pass, so no page holds the
// server for long.
// Only up to the sheet's last row when it begins: a row added meanwhile goes
// past it (nextRowIndex, lib/sheet-busy.ts) and isn't read, so a sheet that
// keeps growing (webhooks, appends) can't keep an export going. Once the
// sheet's last rows are deleted, though, the next rows added take their places
// and are read. A row edited meanwhile is read as it is when reached. A row
// deleted meanwhile is in the export if it was reached before, and not if after.
// `ids`: each row's stable id, beside its data (JSON lines writes it).
export async function eachPage(
  sheetId: string, userId: string,
  apply: (rows: Array<string | null>, ids: string[]) => boolean | Promise<boolean>,
  filter?: CompiledFilter,
): Promise<void> {
  const page = db.prepare(`
    SELECT row_index, ${filter ? `CASE WHEN ${filter.sql} THEN data END` : 'data'}, id FROM rows
    WHERE sheet_id = ? AND user_id = ? AND row_index > ? AND row_index <= ? ORDER BY row_index LIMIT ?
  `).raw();
  const params = filter?.params ?? [];
  const last = (db.prepare('SELECT MAX(row_index) FROM rows WHERE sheet_id = ? AND user_id = ?').pluck()
    .get(sheetId, userId) as number | null) ?? Number.MIN_SAFE_INTEGER;
  for (let after = Number.MIN_SAFE_INTEGER; ;) {
    const rows = page.all(...params, sheetId, userId, after, last, EXPORT_PAGE_ROWS) as
      Array<[number, string | null, string]>;
    if (!(await apply(rows.map(r => r[1]), rows.map(r => r[2]))) || rows.length < EXPORT_PAGE_ROWS) return;
    after = rows[rows.length - 1][0];
    if (after >= last) return;
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

// One row as a JSON line: its id and its cells, as read_rows answers a row ({ id, data }), so a column named "id"
// can't clash with the row's own. Every exported column is in data, in the export's order, '' where the row has no
// value (as the CSV's empty cell); a value keeps its JSON type. No formula quote: no spreadsheet opens JSON.
export function jsonLine(columns: string[], id: string, data: Record<string, string>): string {
  const cells: Record<string, unknown> = Object.create(null);
  for (const col of columns) cells[col] = cellOf(data, col);
  return JSON.stringify({ id, data: cells });
}

// The sheet as JSON lines: each page's matching rows as one chunk (no header line), handed to `write`, which says
// whether to go on. The same pages, filter and row order as writeSheetCsv. Returns how many rows went out.
export async function writeSheetJsonl(
  sheetId: string, userId: string, plan: SheetExportPlan, write: (chunk: string) => Promise<boolean>,
): Promise<number> {
  let rowCount = 0;
  await eachPage(sheetId, userId, async (rows, ids) => {
    let chunk = '';
    rows.forEach((json, i) => {
      if (json === null) return;
      chunk += jsonLine(plan.columns, ids[i], parseRowData(json)) + '\n';
      rowCount++;
    });
    return chunk ? write(chunk) : true;
  }, plan.filter);
  return rowCount;
}

// At most this much in one write. A client that stopped reading is cut off once a write makes no progress for a
// while, and Windows shows none inside a write, so there the wait grows with the write (lib/answer-stall.ts).
const WRITE_MAX_BYTES = 1024 * 1024;

// `write` for an HTTP response: it waits while the client is behind, and stops
// once the client has gone. A page goes out in writes of at most WRITE_MAX_BYTES.
export function responseWriter(res: Response): (chunk: string) => Promise<boolean> {
  return async chunk => {
    const bytes = Buffer.from(chunk);
    for (let at = 0; at < bytes.length; at += WRITE_MAX_BYTES) {
      if (res.destroyed) return false;
      if (!res.write(bytes.subarray(at, at + WRITE_MAX_BYTES))) await drained(res);
    }
    return !res.destroyed;
  };
}

// Resolves when the client has taken the buffered output, or has gone away (one that stopped reading is cut
// off after a while: lib/answer-stall.ts).
function drained(res: Response): Promise<void> {
  return new Promise(resolve => {
    if (res.destroyed) return resolve();
    const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
    res.on('drain', done);
    res.on('close', done);
  });
}
