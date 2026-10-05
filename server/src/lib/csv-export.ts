// Shared CSV builder for the UI export route and /api/v1 (extracted from
// routes/sheets-csv-export.ts verbatim). escapeCsvCell neutralizes formula
// injection (=, +, -, @, \t, \r first chars) — this is the boundary where CSV
// injection matters: the spreadsheet app the user opens the file in.
import type { Response } from 'express';
import { db } from './db';
import { getSheetColumns, parseRowData } from './sql-helpers';
import { contentDispositionFilename, escapeCsvCell } from './csv-safety';
import { withSheetRead } from './sheet-busy';
import { yieldToRequests } from './slices';
// Reuses read_rows' filter predicate rather than a second implementation, so
// `where` means exactly the same thing on both tools. (lib -> services is the
// unusual direction; row-selection itself only depends on lib, so there's no
// cycle, and lib/server-lifecycle.ts sets the same precedent.)
import { rowPasses, validateRowConditions, type RowCondition } from '../services/row-selection';

export type { RowCondition };

export type CsvExport =
  | {
      ok: true; sheetName: string; csv: string; columns: string[];
      // Rows in `csv`, and every row the filter matched. They differ only
      // when the CSV reached maxChars and the rest was left out (truncated);
      // then matchingRows is the sheet's row count without a filter, and null
      // (not counted) with one: counting would read the rest of the sheet.
      rowCount: number; matchingRows: number | null; truncated: boolean;
    }
  | { fail: 'not_found' }
  | { fail: 'empty' }
  | { fail: 'invalid'; error: string }
  | { fail: 'busy'; error: string };

export interface CsvExportOptions {
  // Subset + ORDER of columns to emit. Omitted = every column in sheet order.
  columns?: string[];
  // Row filter, same shape read_rows accepts (services/row-selection.ts).
  where?: RowCondition[];
  // Stop (never at half a row) once the CSV would pass this many characters.
  // Default: no limit.
  maxChars?: number;
}

// Build a sheet's CSV, optionally projected to a column subset and filtered to
// matching rows.
//
// Projection/filtering exist because returning the WHOLE sheet as one string is
// usually the expensive option, not the cheap one: an agent asking for 300 rows
// x 4 columns out of 1,735 x 18 paid ~26x the cells it needed, which is worse
// than the paged read_rows it was told to prefer (dogfood, 2026-07-25). The
// filtering itself is not new — queryRows has done it for read_rows all along;
// it simply was not wired to this path.
export async function buildSheetCsv(
  sheetId: string, userId: string, opts: CsvExportOptions = {},
): Promise<CsvExport> {
  const sheet = db.prepare('SELECT name FROM sheets WHERE id = ? AND user_id = ?')
    .get(sheetId, userId) as { name: string } | undefined;
  if (!sheet) return { fail: 'not_found' };

  // The same verified list the grid shows (column_order). selfHeal=false: an
  // export never writes.
  const allColumns = getSheetColumns(sheetId, userId, false);

  // Validate BEFORE reading rows: a typo'd column name must be a clean error,
  // not a CSV silently full of blanks (the failure mode a caller can't see).
  let columns = allColumns;
  if (opts.columns?.length) {
    const known = new Set(allColumns);
    const unknown = opts.columns.filter(c => !known.has(c));
    if (unknown.length > 0) {
      return { fail: 'invalid', error: `Unknown column(s): ${unknown.join(', ')}. Use get_sheet to list them.` };
    }
    // Caller's order wins — they may want a different layout than the sheet's.
    columns = opts.columns;
  }
  if (opts.where?.length) {
    const condErr = validateRowConditions(allColumns, opts.where);
    if (condErr) return { fail: 'invalid', error: condErr };
  }

  // Rows a page at a time between requests (each row's JSON parsed once, for
  // the filter and the line alike), holding off heavy operations meanwhile.
  const maxChars = opts.maxChars ?? Number.POSITIVE_INFINITY;
  const outcome = await withSheetRead(sheetId, async (): Promise<CsvExport> => {
    const lines = [columns.map(escapeCsvCell).join(',')];
    let chars = lines[0].length, sheetRows = 0, truncated = false;
    await eachPage(sheetId, userId, rows => {
      for (const json of rows) {
        sheetRows++;
        const data = parseRowData(json);
        if (opts.where?.length && !rowPasses(data, opts.where)) continue;
        const line = columns.map(col => escapeCsvCell(data[col] ?? '')).join(',');
        if (chars + 2 + line.length > maxChars) { truncated = true; return false; }
        lines.push(line);
        chars += 2 + line.length;
      }
      return true;
    });
    const rowCount = lines.length - 1;
    const matchingRows = !truncated ? rowCount
      : opts.where?.length ? null
      : (db.prepare('SELECT COUNT(*) AS n FROM rows WHERE sheet_id = ? AND user_id = ?').get(sheetId, userId) as { n: number }).n;
    // An empty SHEET is 'empty' (the historical contract the UI route 400s on).
    // A filter that matched nothing is NOT empty — it's a valid result, and the
    // caller still wants the header row to know the query ran.
    if (sheetRows === 0) return { fail: 'empty' };
    return {
      ok: true, sheetName: sheet.name, csv: lines.join('\r\n'), columns,
      rowCount, matchingRows, truncated,
    };
  });
  return 'busy' in outcome && typeof outcome.busy === 'string' ? { fail: 'busy', error: outcome.busy } : outcome as CsvExport;
}

// The sheet's row data in row order, EXPORT_PAGE_ROWS at a time, yielding to
// other requests between pages, until `apply` returns false.
async function eachPage(sheetId: string, userId: string, apply: (rows: string[]) => boolean): Promise<void> {
  const page = db.prepare(`
    SELECT row_index, data FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index > ?
    ORDER BY row_index LIMIT ?
  `).raw();
  for (let after = Number.MIN_SAFE_INTEGER; ;) {
    const rows = page.all(sheetId, userId, after, EXPORT_PAGE_ROWS) as Array<[number, string]>;
    if (!apply(rows.map(r => r[1])) || rows.length < EXPORT_PAGE_ROWS) return;
    after = rows[rows.length - 1][0];
    await yieldToRequests();
  }
}

const EXPORT_PAGE_ROWS = 5_000;

// The whole sheet as a CSV download, written to `res` a page of rows at a time
// between requests: a million-row export holds one page in memory and never
// freezes the server. Same columns, escaping, row order and line breaks as
// buildSheetCsv. Heavy operations (a sort, an import, a column rewrite) wait
// until it finishes (lib/sheet-busy.ts), so rows can't move under its cursor;
// writes wait for the client to drain, and a client that leaves stops it.
// Sends headers and body itself and returns 'ok'; otherwise sends nothing.
export async function streamSheetCsv(
  sheetId: string, userId: string, res: Response,
): Promise<'ok' | 'not_found' | 'empty' | { busy: string }> {
  const sheet = db.prepare('SELECT name FROM sheets WHERE id = ? AND user_id = ?')
    .get(sheetId, userId) as { name: string } | undefined;
  if (!sheet) return 'not_found';
  if (!db.prepare('SELECT 1 FROM rows WHERE sheet_id = ? AND user_id = ? LIMIT 1').get(sheetId, userId)) return 'empty';
  return withSheetRead(sheetId, async () => {
    const columns = getSheetColumns(sheetId, userId, false);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', contentDispositionFilename(sheet.name, 'csv'));
    const page = db.prepare(`
      SELECT row_index, data FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index > ?
      ORDER BY row_index LIMIT ?
    `).raw();
    let chunk = columns.map(escapeCsvCell).join(',');
    for (let after = Number.MIN_SAFE_INTEGER; ;) {
      const rows = page.all(sheetId, userId, after, EXPORT_PAGE_ROWS) as Array<[number, string]>;
      for (const [, json] of rows) {
        const data = parseRowData(json);
        chunk += '\r\n' + columns.map(col => escapeCsvCell(data[col] ?? '')).join(',');
      }
      if (res.destroyed) break;
      if (!res.write(chunk)) await drained(res);
      chunk = '';
      if (rows.length < EXPORT_PAGE_ROWS || res.destroyed) break;
      after = rows[rows.length - 1][0];
      await yieldToRequests();
    }
    res.end();
    return 'ok' as const;
  });
}

// Resolves when the client has taken the buffered output, or has gone away
// (then the loop above stops at its next check).
function drained(res: Response): Promise<void> {
  return new Promise(resolve => {
    if (res.destroyed) return resolve();
    const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
    res.on('drain', done);
    res.on('close', done);
  });
}
