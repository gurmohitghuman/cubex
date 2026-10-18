// The run state of a cell in an AI, HTTP API or enrichment column (pure), told
// only from the words a run writes (lib/run-markers.ts): still running (⏳, or
// ➕ while a list job's rows are on their way), failed (❌), kept out by "Only
// run if" (⏭️ Condition not met), finished without a value (any other ⏭️, such
// as "Not found"), not run (blank), or done (anything else, ✅ Found included).
// A done row, or one done without a value, whose input cells changed since its
// run made it is out of date (`stale`: the run's fingerprint differs, read by
// the caller in SQL, lib/run-inputs).
// A blank output column reads the run's state from its status column in the
// same row: a failed or kept-out row leaves its outputs empty and says why in
// the status cell only. sql.ts holds the same rules as SQL; the unit tests run
// both over the same cells.
import { CONDITION_NOT_MET, FAILED_MARK, LIST_MARK, RUNNING_MARK, SKIPPED_MARK, trimBlank } from '../run-markers';

export type CellStatus =
  | 'done' | 'no_result' | 'error' | 'condition_not_met' | 'running' | 'not_run' | 'out_of_date';

const blank = (v: unknown): string => trimBlank(v === null || v === undefined ? '' : String(v));

function markerStatus(t: string): CellStatus | null {
  if (t.startsWith(RUNNING_MARK) || t.startsWith(LIST_MARK)) return 'running';
  if (t.startsWith(FAILED_MARK)) return 'error';
  if (t === CONDITION_NOT_MET) return 'condition_not_met';
  if (t.startsWith(SKIPPED_MARK)) return 'no_result';
  return null;
}

// `state`: the run's status cell in the same row, for an output column; leave
// it out for the status column itself (a blank cell is then not run).
function heldStatus(own: unknown, state: unknown): CellStatus {
  const o = blank(own);
  if (o) return markerStatus(o) ?? 'done';
  const s = blank(state);
  if (!s) return 'not_run';
  const m = markerStatus(s);
  return m === 'running' || m === 'error' || m === 'condition_not_met' ? m : 'no_result';
}

export function cellStatus(own: unknown, state: unknown = '', stale = false): CellStatus {
  const status = heldStatus(own, state);
  return stale && (status === 'done' || status === 'no_result') ? 'out_of_date' : status;
}

// A cell as read_rows' include_status returns it. value: the cell as written,
// only when done (or out of date with a value). error: what a failed run wrote
// ("❌ Error: Rate limited" → "Rate limited"). reason: Cubex's words for a row
// that finished without a value ("Not found", "Budget ran out"), when it wrote any.
export interface CellStatusView {
  status: CellStatus;
  value: string | null;
  error: string | null;
  reason?: string;
}

// The words after the mark: "❌ Error: Rate limited" → "Rate limited".
function words(cell: string, mark: string): string {
  const rest = cell.slice(mark.length).trim();
  const detail = rest.replace(/^error\s*:\s*/i, '');
  return detail || rest;
}

export function cellStatusView(own: unknown, state: unknown = '', stale = false): CellStatusView {
  const status = cellStatus(own, state, stale);
  const held = heldStatus(own, state);
  if (held === 'done') return { status, value: String(own), error: null };
  // The cell that says it: the own cell, or the status cell behind a blank one.
  const said = blank(own) || blank(state);
  if (status === 'error') return { status, value: null, error: words(said, FAILED_MARK) || 'Error' };
  if (held === 'no_result' && said.startsWith(SKIPPED_MARK)) {
    const reason = words(said, SKIPPED_MARK);
    return reason ? { status, value: null, error: null, reason } : { status, value: null, error: null };
  }
  return { status, value: null, error: null };
}
