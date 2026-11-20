import { db } from './db';
import { oneTransaction } from './slices';
import { jsonPath } from './sql-rows';
import { eachRowIdSlice, sheetRowIds } from './row-order';
import { PLACEHOLDER } from './run-markers';
import { journalSeed, type RunRef } from './run-undo/journal';
import { clearBackFor, KEPT_EMPTY_SQL, KEPT_VALUE_SQL } from './run-undo/clear-back';
import { derivedReaderCount, derivedReaderIds } from './autorun-mark';
import { kickSpanReaders, tellDerivedSpan } from './derived-spans';
import { HEAVY_SLICE_ROWS, PLACEHOLDER_CLEAR_BACK_ROWS } from './constants';

// The '⏳ Processing...' placeholder an AI or HTTP run writes into its cells:
// seeded on every target row at run start, replaced by each processed row, and
// cleared from whatever is left when a run is cancelled or fails (each such
// cell back to what it held before the run). On a sheet of a million rows both
// are heavy, so they work HEAVY_SLICE_ROWS rows at a time, one short
// transaction each (lib/slices.ts): the server keeps answering, and SQLite's
// write lock is free between slices for autosave, webhooks and workers.
export { PLACEHOLDER };

// Clear the placeholder from `columnNames` wherever a row still holds exactly
// it. With `run` (the run that just ended early), such a cell is at a row the
// run never reached and gets back the value the run's undo journal kept for it
// from before the run, with its type (lib/run-undo/clear-back.ts); with
// nothing kept there, or without `run`, it becomes ''. Every other cell keeps
// its value, so results the run wrote before it ended stay, and json_replace
// never creates a key: a row without one of the columns stays without it.
// Rows go in storage order (lib/row-order.ts); `afterSlice` runs after each
// slice (a progress heartbeat). Open grids reload as slices land: each slice
// that cleared a row moves the sheet's data_version.
// A clean, formula or lookup column reading these columns holds what it
// worked out from the cell before the run, or from the ⏳ if the row changed
// meanwhile. Each of them reads a ⏳ as empty (tests/unit/readers-read-
// placeholder-empty.test.ts), so a cell that read as empty before the run
// (the journal kept nothing, '', a ⏳ or a list job's words: KEPT_EMPTY_SQL)
// and becomes '' changes nothing it worked out: a run's first try on a new
// column tells them nothing. Every other cleared row (a cell put back, or one
// whose old value the journal didn't keep: a run from before runs could be
// undone) is told to them in the slice's transaction as one span: the slice's
// told rowids and a mark per reader (lib/derived-spans.ts), quiet, so nothing
// that costs runs. A slice costs the same with 0 or 20 readers: queuing each
// told row for each reader wrote a page per row and reader. The readers are
// counted again in each slice's transaction: nothing holds off a column that
// starts reading these while the clear goes, and it fills rows ahead of the
// clear from the ⏳. They start on the spans once the clear has ended (it
// kicks them in the API process: lib/run-placeholders.ts; a run worker's
// clear, a failed run's, leaves them to the auto-run sweep). A slice is
// HEAVY_SLICE_ROWS rows. On the server's thread each slice commits with
// SQLite's own checkpoint off, its WAL copied back on the checkpoint worker's
// thread (lib/bulk-slices.ts); on a job thread it is checkpointed after it
// when columns read these from the start (lib/row-order.ts). Journal lookups
// cost too: putting K columns back takes one per cell, and telling the columns
// reading them one more, so a slice also holds at most
// PLACEHOLDER_CLEAR_BACK_ROWS / (1 + K) rows, or / (1 + 2K) when read.
export async function clearProcessingPlaceholders(
  sheetId: string, userId: string, columnNames: string[], afterSlice?: () => void, run?: RunRef,
): Promise<void> {
  if (columnNames.length === 0) return;
  const paths = columnNames.map(jsonPath);
  const back = run ? clearBackFor(run, userId, columnNames) : null;
  const slots = paths.map((_, i) => back?.slots[i] ?? null);
  // Per column: its path, then its new value: where it holds ⏳, what was kept
  // there (one lookup by the journal's primary key) or ''; else itself.
  const sets = paths.map((p, i) => {
    const value = slots[i] === null ? { sql: "''", args: [] }
      : { sql: `COALESCE(${KEPT_VALUE_SQL}, '')`, args: [back!.undoId, slots[i]] };
    return {
      sql: `?, CASE WHEN json_extract(data, ?) = '${PLACEHOLDER}' THEN ${value.sql} ELSE json_extract(data, ?) END`,
      args: [p, p, ...value.args, p],
    };
  });
  const sliceSql = ' WHERE rowid IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ? AND (';
  const clear = db.prepare(
    'UPDATE rows SET data = json_replace(data, ' + sets.map(s => s.sql).join(', ') + ')' +
    ", updated_at = datetime('now')" + sliceSql +
    paths.map(() => `json_extract(data, ?) = '${PLACEHOLDER}'`).join(' OR ') + ') RETURNING rowid',
  ).pluck();
  const setArgs = sets.flatMap(s => s.args);
  // The rows of a slice the columns reading these must hear of, in storage order: a cell holding ⏳ that didn't
  // read as empty before the run.
  const told = paths.map((p, i) => (slots[i] === null
    ? { sql: `json_extract(data, ?) = '${PLACEHOLDER}'`, args: [p] }
    : { sql: `(json_extract(data, ?) = '${PLACEHOLDER}' AND NOT ${KEPT_EMPTY_SQL})`,
      args: [p, back!.undoId, slots[i]] }));
  const tell = db.prepare('SELECT rowid FROM rows' + sliceSql + told.map(t => t.sql).join(' OR ') +
    ') ORDER BY rowid').pluck();
  const tellArgs = told.flatMap(t => t.args);
  const rowIds = await sheetRowIds(sheetId, userId);
  let readers = derivedReaderCount(sheetId, userId, columnNames);
  const restoring = slots.filter(s => s !== null).length;
  const sliceRows = (read: boolean) => Math.max(1, Math.floor(Math.min(HEAVY_SLICE_ROWS,
    PLACEHOLDER_CLEAR_BACK_ROWS / (1 + (read ? 2 : 1) * restoring))));
  const readRows = sliceRows(true);
  const bump = db.prepare('UPDATE sheets SET data_version = data_version + 1 WHERE id = ? AND user_id = ?');
  await eachRowIdSlice(rowIds, (json, window) => {
    let took = window.length;
    const first = (n: number) => (n === window.length ? json : JSON.stringify(Array.from(window.subarray(0, n))));
    // The clear and its span commit together, the write lock taken up front.
    oneTransaction(() => {
      const ids = derivedReaderIds(sheetId, userId, columnNames);
      readers = ids.length;
      let heard: number[] = [];
      if (readers > 0) {
        took = Math.min(took, readRows);
        heard = tell.all(first(took), sheetId, userId, ...tellArgs) as number[];
      }
      const cleared = clear.all(...setArgs, first(took), sheetId, userId, ...paths) as number[];
      tellDerivedSpan(sheetId, userId, ids, heard, run);
      if (cleared.length > 0) bump.run(sheetId, userId);
    });
    afterSlice?.();
    return took;
  }, { rows: readers > 0 ? readRows : sliceRows(false), checkpointed: readers > 0 });
  bump.run(sheetId, userId);
  // A run's clear kicks its readers once the run lets its columns go (lib/run-placeholders.ts).
  if (!run) kickSpanReaders(sheetId);
}

// Seed the placeholder into `columns` of a run's target rows: every row up to
// and including `lastRow` when `targets` is null (rows appended meanwhile are
// not part of the run), else exactly the `targets`. `skip` rows keep their
// value (promoted preview results). Rows go in storage order
// (lib/row-order.ts). `live` is checked before each slice, in the same tick as
// its write: once it returns false (the run was cancelled while starting)
// nothing more is written, so the cancel's clear, which starts after that,
// sees every placeholder. Returns false when it stopped early. What the cells
// held is kept in the run's undo journal first (lib/run-undo/journal.ts).
export async function seedProcessingPlaceholders(args: {
  run: RunRef; sheetId: string; userId: string; columns: string[];
  targets: number[] | null; lastRow: number; skip?: Set<number>; live: () => boolean;
}): Promise<boolean> {
  const { run, sheetId, userId, columns, targets, lastRow, live } = args;
  if (columns.length === 0) return true;
  const paths = columns.map(jsonPath);
  const set = db.prepare(
    'UPDATE rows SET data = json_set(data' + paths.map(() => `, ?, '${PLACEHOLDER}'`).join('') + ')' +
    ", updated_at = datetime('now')" +
    ' WHERE rowid IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?' +
    ' AND row_index NOT IN (SELECT value FROM json_each(?))',
  );
  const skip = JSON.stringify([...(args.skip ?? [])]);
  const rowIds = await sheetRowIds(sheetId, userId, targets ? { targets } : { upTo: lastRow });
  let stopped = false;
  const cells = columns.map((c): [string, string] => [c, PLACEHOLDER]);
  await eachRowIdSlice(rowIds, ids => {
    if (!live()) { stopped = true; return false; }
    // The write lock first: a read before a write in a deferred transaction
    // fails at once (SQLITE_BUSY) when a run worker committed in between.
    oneTransaction(() => {
      journalSeed(run, sheetId, userId, { rowids: ids }, cells, skip);
      set.run(...paths, ids, sheetId, userId, skip);
    });
  });
  return !stopped;
}
