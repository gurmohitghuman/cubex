// One item of a setup call's results (pure, services/setup-call.ts): its working-table row's cells for the columns
// the setup makes. A cell holding Cubex's words instead of a value (a step failed, found nothing, was kept out by
// its "Only run if" rule, or was still filling when the call stopped: lib/run-markers.ts) is never given out as an
// output: it reads null there, and the item's status (and error, for a failure) says what happened, as read_rows'
// include_status tells such cells apart (lib/row-filter/cell-status.ts). The item's status is the first of these
// that any of its columns has: error, running, condition_not_met, no_result, done; not_run when every one is empty.
import { cellStatusView, type CellStatus } from '../row-filter/cell-status';

export type CallItemStatus = Exclude<CellStatus, 'out_of_date'>;
export interface SetupCallItem {
  item: number;                            // its place in the items sent, from 0
  status: CallItemStatus;
  error: string | null;                    // with status error: the column and why it failed
  outputs: Record<string, string | null>;  // each column the setup makes: its value, null when it has none
}

const ORDER: readonly CallItemStatus[] = ['error', 'running', 'condition_not_met', 'no_result', 'done', 'not_run'];

const textOf = (v: unknown): string => (v === null || v === undefined ? ''
  : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function callItem(item: number, cells: Record<string, unknown>, columns: readonly string[]): SetupCallItem {
  const outputs: Record<string, string | null> = Object.create(null);
  let status: CallItemStatus = 'not_run';
  let error: string | null = null;
  for (const column of columns) {
    const own = Object.prototype.hasOwnProperty.call(cells, column) ? textOf(cells[column]) : '';
    const view = cellStatusView(own);
    outputs[column] = view.value;
    const s = view.status as CallItemStatus;
    if (s === 'error' && error === null) error = `${column}: ${view.error ?? 'Error'}`;
    if (ORDER.indexOf(s) < ORDER.indexOf(status)) status = s;
  }
  return { item, status, error, outputs };
}
