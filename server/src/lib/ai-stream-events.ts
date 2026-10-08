import { db } from './db';
import type { OutputColumnSpec } from './ai-multi-output';
import { aiDataCellSummary, parseScrapedData, parseSearchQueries } from './ai-data-cell';

// The live 'result' events the AI SSE stream (routes/ai-stream.ts) sends for one
// ai_results row: what each run kind's cells look like on the wire.

// The ai_runs fields these events need (read once per stream tick).
export interface StreamRun {
  column_name: string;
  use_openrouter_web_search: number;
  output_columns: string | null;
  sheet_id: string;
  status_column: string | null;
  data_column: string | null;
}

export interface StreamResult {
  id: string; row_index: number; output_value: string; status: string; error_message: string | null;
  scraped_data: string | null; cost_usd: number | null; web_search_queries: string | null;
}

// A STRUCTURED (multi-column) run writes N typed columns + the status column
// (+ "(Data)") per row in one txn (ai-row-writers-multi.ts), and
// ai_results.output_value holds only the raw JSON. So its event reads the row's
// cells back from rows.data: the client gets exactly what was saved, with no
// second derivation that could drift from ai-row-multi.ts. Point lookup on
// UNIQUE(sheet_id, user_id, row_index); json_each keeps the SQL static.
const ROW_CELLS_SQL = `
  SELECT j.key AS col, j.value AS val
  FROM rows r, json_each(r.data) j
  WHERE r.user_id = ? AND r.sheet_id = ? AND r.row_index = ?
    AND j.key IN (SELECT value FROM json_each(?))`;

// Every column a structured run writes, status column first; null for a
// single-column run.
export function structuredRunColumns(run: StreamRun): string[] | null {
  if (!run.output_columns) return null;
  const specs = JSON.parse(run.output_columns) as OutputColumnSpec[];
  const columns = [run.status_column || run.column_name, ...specs.map(s => s.columnName)];
  if (run.data_column) columns.push(run.data_column);
  return columns;
}

// The row's current value for each column ('' when the key is absent or null).
export function readRowCells(
  userId: string, sheetId: string, rowIndex: number, columns: string[],
): Record<string, string> {
  const found = db.prepare(ROW_CELLS_SQL).all(userId, sheetId, rowIndex, JSON.stringify(columns)) as
    Array<{ col: string; val: unknown }>;
  const cells: Record<string, string> = Object.fromEntries(columns.map(c => [c, '']));
  for (const { col, val } of found) cells[col] = val === null || val === undefined ? '' : String(val);
  return cells;
}

export function resultEvents(
  userId: string, run: StreamRun, row: StreamResult, structuredColumns: string[] | null,
): object[] {
  // Structured: one event carrying every cell the row's write touched.
  if (structuredColumns) {
    return [{
      type: 'result', rowIndex: row.row_index, status: row.status,
      cells: readRowCells(userId, run.sheet_id, row.row_index, structuredColumns),
    }];
  }
  const events: object[] = [{
    type: 'result',
    rowIndex: row.row_index,
    columnName: run.column_name,
    outputValue: row.status === 'failed' ? '' : row.output_value,
    status: row.status,
    resultId: row.id,
    errorMessage: row.error_message || undefined,
    hasScrapedData: !!row.scraped_data,
  }];
  // Data column event — only when the run created a (Data) column.
  if (run.use_openrouter_web_search) {
    const dataColName = run.column_name.endsWith(' (Output)')
      ? run.column_name.replace(/ \(Output\)$/, ' (Data)')
      : `${run.column_name} (Data)`;
    // Reconstruct the SAME (Data) cell the worker persisted (sources,
    // searches, cost: lib/ai-data-cell.ts) instead of always sending '',
    // which blanked a populated (Data) cell live until a reload (L9).
    const dataValue = row.status === 'failed'
      ? '❌ Error'
      : aiDataCellSummary(parseScrapedData(row.scraped_data), 'Searched', {
        queries: parseSearchQueries(row.web_search_queries), costUsd: row.cost_usd,
      });
    events.push({ type: 'result', rowIndex: row.row_index, columnName: dataColName, outputValue: dataValue,
      status: row.status });
  }
  return events;
}
