import { db } from './db';
import { jsonPath } from './sql-rows';
import { eachRowIdSlice, sheetRowIds } from './row-order';
import { PLACEHOLDER } from './run-markers';
import { journalSeed, type RunRef } from './run-undo/journal';
import { clearBackFor, KEPT_VALUE_SQL } from './run-undo/clear-back';
import { derivedReaderCount, markDerivedInputs } from './autorun-mark';
import { HEAVY_SLICE_ROWS, PLACEHOLDER_CLEAR_BACK_ROWS, PLACEHOLDER_CLEAR_QUEUE_ROWS } from './constants';

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
// slice (a progress heartbeat). Open grids reload when it's done (data_version).
// A clean, formula or lookup column reading these columns holds what it
// worked out from the cell before the run, or from the ⏳ (read as empty) if
// the row changed meanwhile, so it works the rows the clear changed out again:
// queued in the slice's transaction, by the rowids it changed (rows holding a
// real result aren't), quiet, so nothing that costs runs (lib/autorun-mark.ts).
// Queuing tells them at once in the API process (lib/autorun-kick.ts); a run
// worker's clear (a failed run) waits for the auto-run sweep, as its other
// writes do.
// That queuing is most of a slice's work: on rows with random ids, each queued
// row writes a page of its own. So with R columns reading these (counted once
// up front), a slice holds PLACEHOLDER_CLEAR_QUEUE_ROWS / (1 + R) rows (at
// least one), commits with SQLite's own checkpoint off and is checkpointed in
// a turn of its own (runInCheckpointedRowSlices, lib/slices.ts; the numbers
// are in lib/constants.ts). With none, a slice is HEAVY_SLICE_ROWS rows and
// runs no checkpoint, as for every other heavy job. Putting K columns back
// costs a journal lookup per cell, so a slice also holds at most
// PLACEHOLDER_CLEAR_BACK_ROWS / (1 + K) rows.
export async function clearProcessingPlaceholders(
  sheetId: string, userId: string, columnNames: string[], afterSlice?: () => void, run?: RunRef,
): Promise<void> {
  if (columnNames.length === 0) return;
  const paths = columnNames.map(jsonPath);
  const back = run ? clearBackFor(run, userId, columnNames) : null;
  // Per column: its path, then its new value: where it holds ⏳, what was kept
  // there (one lookup by the journal's primary key) or ''; else itself.
  const sets = paths.map((p, i) => {
    const slot = back?.slots[i] ?? null;
    const value = slot === null ? { sql: "''", args: [] }
      : { sql: `COALESCE(${KEPT_VALUE_SQL}, '')`, args: [back!.undoId, slot] };
    return {
      sql: `?, CASE WHEN json_extract(data, ?) = '${PLACEHOLDER}' THEN ${value.sql} ELSE json_extract(data, ?) END`,
      args: [p, p, ...value.args, p],
    };
  });
  const clear = db.prepare(
    'UPDATE rows SET data = json_replace(data, ' + sets.map(s => s.sql).join(', ') + ')' +
    ", updated_at = datetime('now')" +
    ' WHERE rowid IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ? AND (' +
    paths.map(() => `json_extract(data, ?) = '${PLACEHOLDER}'`).join(' OR ') + ') RETURNING rowid',
  ).pluck();
  const setArgs = sets.flatMap(s => s.args);
  const rowIds = await sheetRowIds(sheetId, userId);
  const readers = derivedReaderCount(sheetId, userId, columnNames);
  const restoring = back ? back.slots.filter(s => s !== null).length : 0;
  const rows = Math.min(HEAVY_SLICE_ROWS, readers === 0 ? Infinity : PLACEHOLDER_CLEAR_QUEUE_ROWS / (1 + readers),
    restoring === 0 ? Infinity : PLACEHOLDER_CLEAR_BACK_ROWS / (1 + restoring));
  const slicing = { rows: Math.max(1, Math.floor(rows)), checkpointed: readers > 0 };
  await eachRowIdSlice(rowIds, ids => {
    // The clear and its queuing commit together, the write lock taken up front.
    db.transaction(() => {
      const cleared = clear.all(...setArgs, ids, sheetId, userId, ...paths) as number[];
      if (cleared.length > 0) markDerivedInputs(sheetId, userId, columnNames, { rowids: cleared });
    }).immediate();
    afterSlice?.();
  }, slicing);
  db.prepare('UPDATE sheets SET data_version = data_version + 1 WHERE id = ? AND user_id = ?').run(sheetId, userId);
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
    db.transaction(() => {
      journalSeed(run, sheetId, userId, { rowids: ids }, cells, skip);
      set.run(...paths, ids, sheetId, userId, skip);
    }).immediate();
  });
  return !stopped;
}
