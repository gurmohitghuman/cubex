// read_rows' and REST rows' include_status (pure): a row's run columns (AI,
// HTTP API, enrichment) as {status, value, error} (cell-status.ts), every
// other column as it is. Every run column the read covers is listed, a cell
// the row doesn't hold included (it reads as not run, or as its run's state).
import { cellStatusView } from './cell-status';
import { cellOf, hasCell } from '../row-cell';

// columns: the read's columns, in their order (all of the row's otherwise).
// runColumns: run column → the column holding its run's state. stale: the
// state columns whose result in this row is out of date (services/run-status-rows.ts).
// errors: state column → the full error text its run recorded at this row; a
// failed cell says it instead of the cell's own short words (reads by id).
export function rowWithStatus(
  data: Record<string, string>, runColumns: ReadonlyMap<string, string>, columns?: readonly string[],
  stale?: ReadonlySet<string>, errors?: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const keys = columns ?? [...new Set([...Object.keys(data), ...runColumns.keys()])];
  const out: Record<string, unknown> = {};
  for (const column of keys) {
    const state = runColumns.get(column);
    if (state === undefined) {
      if (columns || hasCell(data, column)) out[column] = cellOf(data, column);
      continue;
    }
    const view = cellStatusView(cellOf(data, column), state === column ? '' : cellOf(data, state),
      stale?.has(state) ?? false);
    const full = view.status === 'error' ? errors?.get(state) : undefined;
    out[column] = full ? { ...view, error: full } : view;
  }
  return out;
}
