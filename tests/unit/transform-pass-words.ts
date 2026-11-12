// The words transform_column tests expect about passes (services/column-transform-passes.ts), pinned here
// once, and the answers they come in.
export const unfinishedWords = (column: string, rows: number, cursor: string): string =>
  rows === 0
    ? `An earlier transform_column pass into "${column}" is unfinished: it stopped before writing a row. To go `
      + `on, call again with that pass's arguments and cursor set to "${cursor}". To start over from the first row `
      + 'instead, call with restart: true and no cursor.'
    : `An earlier transform_column pass into "${column}" is unfinished: it stopped after `
      + `${rows.toLocaleString('en-US')} row${rows === 1 ? '' : 's'}. To finish it, call again with that pass's `
      + `arguments and cursor set to "${cursor}"; starting over would apply the operation to those rows twice. To `
      + 'start over from the first row instead, applying the operation to every row again, call with restart: true '
      + 'and no cursor: do that when rows changed since the pass stopped, or to run the column with different '
      + 'arguments.'

export const unfinished = (column: string, rows: number, cursor: string) =>
  ({ unfinished: { error: unfinishedWords(column, rows, cursor), next_cursor: cursor, rows_done: rows } })

const invalid = (error: string) => ({ fail: 'invalid', error })

// A cursor whose pass is over: nothing written, no cursor named.
export const notOpen = invalid('This cursor\'s pass is no longer open: it reached the end, was restarted, or its '
  + 'column was deleted for good or its rows were reordered. Nothing was written. To run the column again from '
  + 'the first row, call without cursor.')
export const malformed = invalid('cursor must be the next_cursor a transform_column call answered.')
export const otherSheet = invalid('This cursor is a transform_column pass on another sheet. Nothing was written. '
  + 'Send it with that sheet, or call without cursor to run this column from the first row.')
export const otherColumn = (col: string, target: string) => invalid('This cursor is the unfinished transform_column '
  + `pass into "${col}", not "${target}". Nothing was written. To go on with it, call with target_column "${col}" `
  + 'and that pass\'s arguments.')
export const inTrash = (col: string) => invalid(`This cursor's pass went to the trash with its column "${col}". `
  + 'Nothing was written. Restore the column to go on with it, under the name it comes back as.')
export const otherArgs = (col: string) => invalid('This cursor is the unfinished transform_column pass into '
  + `"${col}", but the arguments differ from that pass's own (the operation, its parameters, the columns it reads `
  + 'or where). Nothing was written. Call again with that pass\'s own arguments to go on; if a column it reads was '
  + 'renamed since, or to run the column with these arguments, call with restart: true and no cursor to start '
  + 'over from the first row, applying the operation to every row again.')
