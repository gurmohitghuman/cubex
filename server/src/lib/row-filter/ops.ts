// The operators of Cubex's row conditions (pure), with one meaning wherever a
// row is checked: read_rows and REST rows/query, CSV export, transfer_rows,
// transform_column and the grid's column filters (compiled to SQL by sql.ts,
// which calls foldText and asNumber as SQL functions), and "Only run if" rules
// (lib/run-condition.ts). Text compares ignore case and outer spaces, and a
// missing cell reads as ''. Run-state operators read the words a run writes
// (cell-status.ts).
export const TEXT_OPS = [
  'eq', 'neq', 'contains', 'not_contains', 'starts_with', 'ends_with', 'empty', 'not_empty',
] as const;
export const LIST_OPS = ['any_of', 'not_any_of'] as const;
export const NUMBER_OPS = ['gt', 'gte', 'lt', 'lte'] as const;
export const STATE_OPS = ['has_error', 'has_result', 'not_run', 'condition_not_met', 'running'] as const;

export type TextOp = (typeof TEXT_OPS)[number];
export type ListOp = (typeof LIST_OPS)[number];
export type NumberOp = (typeof NUMBER_OPS)[number];
export type StateOp = (typeof STATE_OPS)[number];
export type FilterOp = TextOp | ListOp | NumberOp | StateOp;

export const FILTER_OPS = [...TEXT_OPS, ...LIST_OPS, ...NUMBER_OPS, ...STATE_OPS] as const;

const among = <T extends string>(list: readonly T[]) =>
  (op: string): op is T => (list as readonly string[]).includes(op);
export const isFilterOp = among(FILTER_OPS);
export const isTextOp = among(TEXT_OPS);
export const isListOp = among(LIST_OPS);
export const isNumberOp = among(NUMBER_OPS);
export const isStateOp = among(STATE_OPS);

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

// A cell or value as text compares read it: outer spaces off, lower case.
export const foldText = (v: unknown): string => text(v).trim().toLowerCase();

// A number in a cell or a condition: a plain number, or one with thousands
// commas ("1,000", "-2,500.5"). '' and "N/A" are not numbers (Number('') is 0,
// which would pass "> -1"), and nor is "1,5": a comma anywhere else could be a
// decimal comma or a list. A cell that isn't one never passes a number operator.
const THOUSANDS = /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/;
export function asNumber(v: unknown): number | null {
  let t = text(v).trim();
  if (t.includes(',')) {
    if (!THOUSANDS.test(t)) return null;
    t = t.replace(/,/g, '');
  }
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// True = the folded cell passes. `value` is folded too.
export function textPasses(op: TextOp, cell: string, value: string): boolean {
  switch (op) {
    case 'eq': return cell === value;
    case 'neq': return cell !== value;
    case 'contains': return cell.includes(value);
    case 'not_contains': return !cell.includes(value);
    case 'starts_with': return cell.startsWith(value);
    case 'ends_with': return cell.endsWith(value);
    case 'empty': return cell === '';
    case 'not_empty': return cell !== '';
  }
}

export const listPasses = (op: ListOp, cell: string, values: readonly string[]): boolean =>
  (op === 'any_of') === values.includes(cell);

export function numberPasses(op: NumberOp, cell: number | null, value: number | null): boolean {
  if (cell === null || value === null) return false;
  switch (op) {
    case 'gt': return cell > value;
    case 'gte': return cell >= value;
    case 'lt': return cell < value;
    case 'lte': return cell <= value;
  }
}
