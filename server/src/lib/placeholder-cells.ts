import { db } from './db';
import { jsonPath } from './sql-rows';
import { eachRowIdSlice, sheetRowIds } from './row-order';

// The '⏳ Processing...' placeholder an AI or HTTP run writes into its cells:
// seeded on every target row at run start, replaced by each processed row, and
// cleared from whatever is left when a run is cancelled or fails. On a sheet of
// a million rows both are heavy, so they work HEAVY_SLICE_ROWS rows at a time,
// one short transaction each (lib/slices.ts): the server keeps answering, and
// SQLite's write lock is free between slices for autosave, webhooks and workers.
export const PLACEHOLDER = '⏳ Processing...';

// Clear the placeholder from `columnNames` wherever a row still holds exactly
// it: that cell becomes '', every other cell keeps its value, and json_replace
// never creates a key, so a row without one of the columns stays without it.
// Real results written just before a cancel are left untouched. Rows go in
// storage order (lib/row-order.ts); `afterSlice` runs after each slice (a
// progress heartbeat). Open grids reload when it's done (data_version).
export async function clearProcessingPlaceholders(
  sheetId: string, userId: string, columnNames: string[], afterSlice?: () => void,
): Promise<void> {
  if (columnNames.length === 0) return;
  const paths = columnNames.map(jsonPath);
  const keepOrClear = `?, CASE WHEN json_extract(data, ?) = '${PLACEHOLDER}' THEN '' ELSE json_extract(data, ?) END`;
  const clear = db.prepare(
    'UPDATE rows SET data = json_replace(data, ' + paths.map(() => keepOrClear).join(', ') + ')' +
    ' WHERE rowid IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ? AND (' +
    paths.map(() => `json_extract(data, ?) = '${PLACEHOLDER}'`).join(' OR ') + ')',
  );
  const setArgs = paths.flatMap(p => [p, p, p]);
  const rowIds = await sheetRowIds(sheetId, userId);
  await eachRowIdSlice(rowIds, ids => {
    clear.run(...setArgs, ids, sheetId, userId, ...paths);
    afterSlice?.();
  });
  db.prepare('UPDATE sheets SET data_version = data_version + 1 WHERE id = ? AND user_id = ?').run(sheetId, userId);
}

// Seed the placeholder into `columns` of a run's target rows: every row up to
// and including `lastRow` when `targets` is null (rows appended meanwhile are
// not part of the run), else exactly the `targets`. `skip` rows keep their
// value (promoted preview results). Rows go in storage order
// (lib/row-order.ts). `live` is checked before each slice, in the same tick as
// its write: once it returns false (the run was cancelled while starting)
// nothing more is written, so the cancel's clear, which starts after that,
// sees every placeholder. Returns false when it stopped early.
export async function seedProcessingPlaceholders(args: {
  sheetId: string; userId: string; columns: string[];
  targets: number[] | null; lastRow: number; skip?: Set<number>; live: () => boolean;
}): Promise<boolean> {
  const { sheetId, userId, columns, targets, lastRow, live } = args;
  if (columns.length === 0) return true;
  const paths = columns.map(jsonPath);
  const set = db.prepare(
    'UPDATE rows SET data = json_set(data' + paths.map(() => `, ?, '${PLACEHOLDER}'`).join('') + ')' +
    ' WHERE rowid IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?' +
    ' AND row_index NOT IN (SELECT value FROM json_each(?))',
  );
  const skip = JSON.stringify([...(args.skip ?? [])]);
  const rowIds = await sheetRowIds(sheetId, userId, targets ? { targets } : { upTo: lastRow });
  let stopped = false;
  await eachRowIdSlice(rowIds, ids => {
    if (!live()) { stopped = true; return false; }
    set.run(...paths, ids, sheetId, userId, skip);
  });
  return !stopped;
}
