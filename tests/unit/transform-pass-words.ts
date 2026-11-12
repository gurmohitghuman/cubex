// The words transform_column tests expect about passes (services/column-transform-passes.ts), pinned here
// once, and the answers they come in.
export const unfinishedWords = (column: string, rows: number, cursor: string): string =>
  rows === 0
    ? `An earlier transform_column pass into "${column}" is unfinished: it stopped before writing a row. To go `
      + `on, call again with that pass's arguments and cursor set to "${cursor}". To start over from the first row `
      + 'instead, call without cursor: no row has the operation yet.'
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
export const notOpen = invalid('This cursor\'s pass is no longer open: it reached the end, was restarted, was '
  + 'replaced by a call without cursor before it wrote a row, or its column or sheet was deleted for good. '
  + 'Nothing was written. A pass that reached the end already gave every row the operation; a call without '
  + 'cursor applies it to every row again.')
// Any call into a column whose pass rows moved under: nothing written, no cursor named.
export function moved(column: string, rows: number) {
  const head = 'Rows of this sheet moved (a sort, a CSV replace, an import undone, duplicates removed, or rows '
    + `restored from the trash) after the transform_column pass into "${column}" `
  if (rows === 0) {
    return invalid(`${head}stopped before writing a row, so its cursor can't go on. Nothing was written. To run `
      + 'the column, call without cursor: no row has the operation yet.')
  }
  const done = `${rows.toLocaleString('en-US')} row${rows === 1 ? '' : 's'}`
  return invalid(`${head}had done ${done}, so its cursor can't go on. Nothing was written. To run the column `
    + 'again, call with restart: true and no cursor: it applies the operation to every row again, so the '
    + `${done} already done ${rows === 1 ? 'gets' : 'get'} it twice.`)
}
export const malformed = invalid('cursor must be the next_cursor a transform_column call answered.')
export const otherSheet = invalid('This cursor is a transform_column pass on another sheet. Nothing was written. '
  + 'Send it with that sheet, after restoring that sheet from the trash if it is there, or call without cursor to '
  + 'run this column from the first row.')
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
// A cursor's template reading the target by the name its pass started under: name it as it is now.
export const targetRenamed = (was: string, now: string) => invalid(`This cursor's pass read "${was}" in its `
  + `template, and that column is now "${now}". Nothing was written. To go on, send the same call with {{${now}}} `
  + `in place of {{${was}}} and the same cursor.`)
