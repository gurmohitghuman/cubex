// The Usage view as a CSV download (the app, and GET /api/v1/usage with
// format=csv): every row of the range, not just the page the view shows. Runs
// are read a page at a time, yielding to other requests between pages, and
// the response waits for a slow client. Cells are escaped like every export
// (escapeCsvCell: column and sheet names are the user's text).
import type { Response } from 'express';
import { USAGE_CSV_PAGE } from '../lib/constants';
import { contentDispositionFilename, escapeCsvCell } from '../lib/csv-safety';
import { responseWriter } from '../lib/csv-write';
import { yieldToRequests } from '../lib/slices';
import type { UsageGroupBy } from '../lib/usage-query';
import {
  groupRows, runPage, type UsageColumnRow, type UsageDayRow, type UsageFigures, type UsageRunRow, type UsageScope,
} from './usage';

const KIND: Record<string, string> = {
  ai: 'AI', enrichment: 'Enrichment', http: 'HTTP API', waterfall: 'Waterfall', mixed: 'Mixed',
};
const money = (v: number | null) => (v === null ? '' : String(v));
const FIGURE_HEADS = ['Runs', 'Cells run', 'Reused cells', 'AI cost (USD)', 'Own provider key cost (USD)',
  'Enrichment cost (USD)', 'Total cost (USD)', 'Cost per cell (USD)'];
const figureCells = (f: UsageFigures) => [String(f.runs), String(f.cells), String(f.reused_cells),
  money(f.ai_cost_usd), money(f.provider_cost_usd), money(f.enrichment_cost_usd), money(f.total_cost_usd),
  money(f.cost_per_cell_usd)];
const line = (cells: Array<string | null>) => cells.map(escapeCsvCell).join(',');
const sheetOf = (r: { sheet_name: string | null; sheet_deleted: boolean }) =>
  (r.sheet_deleted ? 'Deleted sheet' : r.sheet_name);

const HEADS: Record<UsageGroupBy, string[]> = {
  column: ['Sheet', 'Column', 'Deleted', 'Kind', ...FIGURE_HEADS, 'Last run (UTC)'],
  day: ['Day (UTC)', ...FIGURE_HEADS],
  run: ['Started (UTC)', 'Sheet', 'Column', 'Deleted', 'Kind', 'What ran', 'Status', ...FIGURE_HEADS, 'Run ID'],
};

function rowCells(groupBy: UsageGroupBy, r: UsageColumnRow | UsageDayRow | UsageRunRow): Array<string | null> {
  if (groupBy === 'day') return [(r as UsageDayRow).day, ...figureCells(r)];
  if (groupBy === 'column') {
    const c = r as UsageColumnRow;
    return [sheetOf(c), c.column, c.column_deleted ? 'yes' : '', KIND[c.kind], ...figureCells(c), c.last_run_at];
  }
  const u = r as UsageRunRow;
  return [u.started_at, sheetOf(u), u.column, u.column_deleted ? 'yes' : '', KIND[u.kind], u.what, u.status,
    ...figureCells(u), u.run_id];
}

export async function writeUsageCsv(
  res: Response, s: UsageScope, groupBy: UsageGroupBy, name: string,
): Promise<void> {
  const write = responseWriter(res);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',
    contentDispositionFilename(`${name} usage ${s.range.from} to ${s.range.to} by ${groupBy}`, 'csv'));
  let chunk = line(HEADS[groupBy]);
  if (groupBy !== 'run') {
    // Every column or day (they are few: a day a row is at most the longest range).
    for (const r of groupRows(s, groupBy, -1)) {
      chunk += '\r\n' + line(rowCells(groupBy, r));
    }
    await write(chunk);
    res.end();
    return;
  }
  for (let after: [string, string] | null = null; ;) {
    const rows = runPage(s, after, USAGE_CSV_PAGE);
    for (const r of rows) chunk += '\r\n' + line(rowCells('run', r));
    if (!(await write(chunk)) || rows.length < USAGE_CSV_PAGE) break;
    chunk = '';
    after = [rows[rows.length - 1].started_at, rows[rows.length - 1].run_id];
    await yieldToRequests();
  }
  res.end();
}
