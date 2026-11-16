import { isMainThread } from 'worker_threads';
import { db } from './db';
import { HEAVY_SLICE_ROWS } from './constants';
import { runInSlices } from './slices';
import { takeSliceTurn } from './slice-turn';
import { runInCheckpointedSlices } from './bulk-slices';

// Whole-sheet rewrites (placeholder seeding and clearing, a column's copy or
// strip) visit rows in storage (rowid) order. Row order and storage order part
// ways as soon as a sheet is sorted, and walking a million rows by row_index
// then dirties one scattered page per row: about 4 KB of WAL per row instead of
// a few hundred bytes. SQLite's docs say the same: "the most efficient way to
// apply changes to a B-Tree is to make the changes in key order"
// (https://sqlite.org/rbu.html). So the row ids are collected first, from the
// (sheet_id, user_id, row_index) index a page at a time, then sorted.
// Sorting a million at once held the server 56 ms (a sheet never sorted: they
// come nearly in order) to 140 ms (a sorted one), and several clears at once
// (Stop all) read their pages back to back. So each page is sorted as it's
// read, and the pages are merged a pair at a time, each step taking the
// bulk writers' turn (lib/slice-turn.ts): one a turn of the event loop,
// whoever's.
const READ_PAGE_ROWS = 50_000;

// The rowids of the sheet's rows, ascending: every row, those up to and
// including row_index `upTo`, or exactly the `targets` row indexes.
export async function sheetRowIds(
  sheetId: string, userId: string, opts: { upTo?: number; targets?: number[] } = {},
): Promise<Float64Array> {
  let runs: Float64Array[] = [];
  const step = async (work: () => void) => {
    const done = await takeSliceTurn();
    try { work(); } finally { done(); }
  };
  const sorted = (ids: number[]) => {
    const a = Float64Array.from(ids);
    for (let i = 1; i < a.length; i++) if (a[i] < a[i - 1]) return a.sort();
    return a;
  };
  const targets = opts.targets;
  if (targets) {
    for (let at = 0; at < targets.length; at += READ_PAGE_ROWS) {
      await step(() => {
        const ids: number[] = [];
        for (let i = at; i < Math.min(targets.length, at + READ_PAGE_ROWS); i += 500) {
          const chunk = targets.slice(i, i + 500);
          ids.push(...db.prepare(`SELECT rowid FROM rows WHERE sheet_id = ? AND user_id = ?
            AND row_index IN (${chunk.map(() => '?').join(',')})`).pluck().all(sheetId, userId, ...chunk) as number[]);
        }
        runs.push(sorted(ids));
      });
    }
  } else {
    const page = db.prepare(`
      SELECT row_index, rowid FROM rows
      WHERE sheet_id = ? AND user_id = ? AND row_index > ? AND row_index <= ?
      ORDER BY row_index LIMIT ?
    `).raw();
    const upTo = opts.upTo ?? Number.MAX_SAFE_INTEGER;
    for (let after = Number.MIN_SAFE_INTEGER, more = true; more;) {
      await step(() => {
        const rows = page.all(sheetId, userId, after, upTo, READ_PAGE_ROWS) as Array<[number, number]>;
        runs.push(sorted(rows.map(r => r[1])));
        more = rows.length === READ_PAGE_ROWS;
        if (more) after = rows[rows.length - 1][0];
      });
    }
  }
  while (runs.length > 1) {
    const next: Float64Array[] = [];
    for (let i = 0; i < runs.length; i += 2) {
      if (i + 1 === runs.length) next.push(runs[i]);
      else await step(() => { next.push(merged(runs[i], runs[i + 1])); });
    }
    runs = next;
  }
  return runs[0] ?? new Float64Array(0);
}

// Two ascending runs as one: laid end to end when they don't overlap (the
// pages of a sheet never sorted), else merged.
function merged(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(a.length + b.length);
  if (a.length === 0 || b.length === 0 || a[a.length - 1] <= b[0] || b[b.length - 1] <= a[0]) {
    const [first, second] = a.length === 0 || b.length === 0 || a[a.length - 1] <= b[0] ? [a, b] : [b, a];
    out.set(first);
    out.set(second, first.length);
    return out;
  }
  let i = 0, j = 0, k = 0;
  while (i < a.length && j < b.length) out[k++] = a[i] <= b[j] ? a[i++] : b[j++];
  while (i < a.length) out[k++] = a[i++];
  while (j < b.length) out[k++] = b[j++];
  return out;
}

// Calls `apply` with each slice of `rowIds` (`rows` of them: HEAVY_SLICE_ROWS
// unless a caller whose slices do more per row asks for fewer) as a JSON array,
// for a statement filtering on `rowid IN (SELECT value FROM json_each(?))`, one
// slice per event-loop turn. `apply` returns false to stop early, or how many of
// the slice's rows it took (at least one): the next slice starts after them.
// On the server's thread each slice is one transaction (`apply` inside it, its
// own run flat: oneTransaction), committed with SQLite's own WAL checkpoint off and
// the WAL copied back on the checkpoint worker's thread (lib/bulk-slices.ts): a
// checkpoint inside a commit there syncs the disk while requests wait. Job
// threads and the lookup worker checkpoint their own connection, on their own
// thread, so their slices stay plain (lib/slices.ts), unless `checkpointed`
// (slices that write pages all over the database: a checkpoint after each).
// Write the sheet filter as `+sheet_id = ? AND +user_id = ?`: without the `+`,
// a fresh install (no planner statistics yet) walks the sheet's whole index on
// every slice (about 0.1 s each at 1M rows) instead of looking rows up by rowid.
export async function eachRowIdSlice(
  rowIds: Float64Array, apply: (idsJson: string, ids: Float64Array) => boolean | number | void,
  opts: { rows?: number; checkpointed?: boolean } = {},
): Promise<void> {
  const size = Math.max(1, Math.floor(opts.rows ?? HEAVY_SLICE_ROWS));
  let i = 0;
  const step = (): boolean => {
    if (i >= rowIds.length) return false;
    const ids = rowIds.subarray(i, Math.min(rowIds.length, i + size));
    const out = apply(JSON.stringify(Array.from(ids)), ids);
    i += typeof out === 'number' ? Math.min(ids.length, Math.max(1, Math.floor(out))) : ids.length;
    return out !== false && i < rowIds.length;
  };
  if (rowIds.length > 0 && (isMainThread || opts.checkpointed)) await runInCheckpointedSlices(step);
  else await runInSlices(step);
}
