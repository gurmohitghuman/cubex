// The words of transform_column's answers about passes (column-transform-passes.ts): the refusals of a cursor
// with no open pass behind it, of a call while the column's pass is unfinished or after rows moved under it, and
// the answer of a call that stopped on an error after writing rows. A refusal wrote nothing; one naming no cursor
// has none to give.
import { countOf } from '../lib/change-log';

export const MALFORMED = 'cursor must be the next_cursor a transform_column call answered.';
export const NOT_OPEN = 'This cursor\'s pass is no longer open: it reached the end, was restarted, or its '
  + 'column or sheet was deleted for good. Nothing was written. A pass that reached the end already gave every '
  + 'row the operation; a call without cursor applies it to every row again.';
export const OTHER_SHEET = 'This cursor is a transform_column pass on another sheet. Nothing was written. Send it '
  + 'with that sheet, after restoring that sheet from the trash if it is there, or call without cursor to run '
  + 'this column from the first row.';
export const otherColumn = (col: string, target: string) => 'This cursor is the unfinished transform_column pass '
  + `into "${col}", not "${target}". Nothing was written. To go on with it, call with target_column "${col}" and `
  + 'that pass\'s arguments.';
export const inTrash = (col: string) => `This cursor's pass went to the trash with its column "${col}". Nothing `
  + 'was written. Restore the column to go on with it, under the name it comes back as.';
export const otherArgs = (col: string) => `This cursor is the unfinished transform_column pass into "${col}", but `
  + 'the arguments differ from that pass\'s own (the operation, its parameters, the columns it reads or where). '
  + 'Nothing was written. Call again with that pass\'s own arguments to go on; if a column it reads was renamed '
  + 'since, or to run the column with these arguments, call with restart: true and no cursor to start over from '
  + 'the first row, applying the operation to every row again.';

// The refusal of every call into a column whose pass rows moved under (it had written `rows`; with none, only
// a call with a cursor is refused: one without starts a new pass), naming no cursor.
export function movedWords(column: string, rows: number): string {
  const head = 'Rows of this sheet moved (a sort, a CSV replace, an import undone, duplicates removed, or rows '
    + `restored from the trash) after the transform_column pass into "${column}" `;
  if (rows === 0) {
    return `${head}stopped before writing a row, so its cursor can't go on. Nothing was written. To run the `
      + 'column, call without cursor: no row has the operation yet.';
  }
  const done = countOf(rows, 'row');
  return `${head}had done ${done}, so its cursor can't go on. Nothing was written. To run the column again, call `
    + `with restart: true and no cursor: it applies the operation to every row again, so the ${done} already done `
    + `${rows === 1 ? 'gets' : 'get'} it twice.`;
}

// The refusal of a call into a column whose pass is unfinished, naming the cursor that goes on with it.
export function unfinishedWords(column: string, rows: number, cursor: string): string {
  const head = `An earlier transform_column pass into "${column}" is unfinished: it stopped `;
  if (rows === 0) {
    return `${head}before writing a row. To go on, call again with that pass's arguments and cursor set to `
      + `"${cursor}". To start over from the first row instead, call without cursor: no row has the operation yet.`;
  }
  return `${head}after ${countOf(rows, 'row')}. `
    + `To finish it, call again with that pass's arguments and cursor set to "${cursor}"; starting over would `
    + 'apply the operation to those rows twice. To start over from the first row instead, applying the operation '
    + 'to every row again, call with restart: true and no cursor: do that when rows changed since the pass '
    + 'stopped, or to run the column with different arguments.';
}

// The answer of a call that stopped on an error after writing pages: the error itself is logged, never shown.
export function stoppedOnErrorWords(rows: number, cursor: string, error: unknown): string {
  const busy = String((error as { code?: unknown } | null)?.code ?? '').startsWith('SQLITE_BUSY');
  return `Stopped on an error after ${countOf(rows, 'row')}: `
    + `${busy ? 'the sheet was busy (SQLITE_BUSY)' : 'something went wrong'}. Those rows are written. Call `
    + `transform_column again with the same arguments and cursor set to "${cursor}" to go on. Don't start over `
    + 'without cursor: that would apply the operation to those rows again.';
}
