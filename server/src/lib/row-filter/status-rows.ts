// read_rows' and REST rows' include_status (pure): a row's run columns (AI,
// HTTP API, enrichment) as {status, value, error} (cell-status.ts), every
// other column as it is. Every run column the read covers is listed, a cell
// the row doesn't hold included (it reads as not run, or as its run's state).
import { cellStatusView } from './cell-status';

const has = (data: Record<string, string>, column: string) => Object.prototype.hasOwnProperty.call(data, column);
const cellOf = (data: Record<string, string>, column: string) => (has(data, column) ? data[column] ?? '' : '');

// columns: the read's columns, in their order (all of the row's otherwise).
// runColumns: run column → the column holding its run's state.
export function rowWithStatus(
  data: Record<string, string>, runColumns: ReadonlyMap<string, string>, columns?: readonly string[],
): Record<string, unknown> {
  const keys = columns ?? [...new Set([...Object.keys(data), ...runColumns.keys()])];
  const out: Record<string, unknown> = {};
  for (const column of keys) {
    const state = runColumns.get(column);
    if (state === undefined) {
      if (columns || has(data, column)) out[column] = cellOf(data, column);
      continue;
    }
    out[column] = cellStatusView(cellOf(data, column), state === column ? '' : cellOf(data, state));
  }
  return out;
}
