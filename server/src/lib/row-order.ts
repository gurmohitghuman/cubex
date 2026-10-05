import { db } from './db';
import { HEAVY_SLICE_ROWS } from './constants';
import { runInSlices, yieldToRequests } from './slices';

// Whole-sheet rewrites (placeholder seeding and clearing, a column's copy or
// strip) visit rows in storage (rowid) order. Row order and storage order part
// ways as soon as a sheet is sorted, and walking a million rows by row_index
// then dirties one scattered page per row: about 4 KB of WAL per row instead of
// a few hundred bytes. SQLite's docs say the same: "the most efficient way to
// apply changes to a B-Tree is to make the changes in key order"
// (https://sqlite.org/rbu.html). So the row ids are collected first, from the
// (sheet_id, user_id, row_index) index a page at a time, then sorted.
const READ_PAGE_ROWS = 50_000;

// The rowids of the sheet's rows, ascending: every row, those up to and
// including row_index `upTo`, or exactly the `targets` row indexes.
export async function sheetRowIds(
  sheetId: string, userId: string, opts: { upTo?: number; targets?: number[] } = {},
): Promise<Float64Array> {
  const ids: number[] = [];
  if (opts.targets) {
    for (let i = 0; i < opts.targets.length; i += 500) {
      const chunk = opts.targets.slice(i, i + 500);
      ids.push(...db.prepare(
        `SELECT rowid FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index IN (${chunk.map(() => '?').join(',')})`,
      ).pluck().all(sheetId, userId, ...chunk) as number[]);
      if (i > 0 && i % READ_PAGE_ROWS === 0) await yieldToRequests();
    }
  } else {
    const page = db.prepare(`
      SELECT row_index, rowid FROM rows
      WHERE sheet_id = ? AND user_id = ? AND row_index > ? AND row_index <= ?
      ORDER BY row_index LIMIT ?
    `).raw();
    const upTo = opts.upTo ?? Number.MAX_SAFE_INTEGER;
    for (let after = Number.MIN_SAFE_INTEGER; ;) {
      const rows = page.all(sheetId, userId, after, upTo, READ_PAGE_ROWS) as Array<[number, number]>;
      for (const [, id] of rows) ids.push(id);
      if (rows.length < READ_PAGE_ROWS) break;
      after = rows[rows.length - 1][0];
      await yieldToRequests();
    }
  }
  return Float64Array.from(ids).sort();
}

// Calls `apply` with each HEAVY_SLICE_ROWS of `rowIds` as a JSON array, for a
// statement filtering on `rowid IN (SELECT value FROM json_each(?))`, one slice
// per event-loop turn (lib/slices.ts). `apply` returns false to stop early.
// Write the sheet filter as `+sheet_id = ? AND +user_id = ?`: without the `+`,
// a fresh install (no planner statistics yet) walks the sheet's whole index on
// every slice (about 0.1 s each at 1M rows) instead of looking rows up by rowid.
export async function eachRowIdSlice(rowIds: Float64Array, apply: (idsJson: string) => boolean | void): Promise<void> {
  let i = 0;
  await runInSlices(() => {
    if (i >= rowIds.length) return false;
    const end = Math.min(rowIds.length, i + HEAVY_SLICE_ROWS);
    const keepGoing = apply(JSON.stringify(Array.from(rowIds.subarray(i, end))));
    i = end;
    return keepGoing !== false && i < rowIds.length;
  });
}
