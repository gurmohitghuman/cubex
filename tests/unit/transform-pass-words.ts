// The words transform_column tests expect while a pass into a column is unfinished
// (services/column-transform-passes.ts), pinned here once, and the answer they come in.
export const unfinishedWords = (column: string, rows: number, cursor: string): string =>
  `An earlier transform_column pass into "${column}" is unfinished: it stopped after `
  + `${rows.toLocaleString('en-US')} row${rows === 1 ? '' : 's'}. To finish it, call again with that pass's `
  + `arguments and cursor set to "${cursor}"; starting over would apply the operation to those rows twice. To `
  + 'start over from the first row instead, applying the operation to every row again, call with restart: true '
  + 'and no cursor: do that when rows changed since the pass stopped, or to run the column with different '
  + 'arguments.'

export const unfinished = (column: string, rows: number, cursor: string) =>
  ({ unfinished: { error: unfinishedWords(column, rows, cursor), next_cursor: cursor, rows_done: rows } })
