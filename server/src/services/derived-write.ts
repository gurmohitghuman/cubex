// Writing a derived column's cells (derived-kind.ts), for the fill
// (derived-fill.ts) and auto-run's follow (derived-follow.ts) alike. Call
// inside the transaction that read the rows. A cell is written only when its
// value changes, and an empty result removes the key (a missing key is an
// empty cell), so working a row out again changes nothing and queues nothing
// for the auto-runs that read the column. A slice stops once it has taken
// BULK_SLICE_MS since it began reading (lib/slice-clock.ts): the pass works out
// as many rows as fit half of that (at least one; none when it must be prepared
// again), and their cells are written until the time is up (at least one).
// `done` says how many rows the slice got through, in order, and the caller
// moves its cursor that far. Reading stops at DERIVED_SLICE_CHARS, and a
// follow's next slice reads about twice what the last one worked out
// (pageAfter), a fill's as many as fit the time at the last one's pace
// (pageByTime), so rows a slice didn't reach are never read many times over. An input holding a
// run's own words (⏳, ❌, ⏭️, ➕) is empty, never data: "⏭️ Not found" must not
// become the last name "Found".
import { db } from '../lib/db';
import {
  BULK_SLICE_MS, DERIVED_QUEUED_SLICE_FRAMES, DERIVED_QUEUED_SLICE_ROWS, DERIVED_SLICE_CHARS, HEAVY_SLICE_ROWS,
} from '../lib/constants';
import { sliceClock } from '../lib/slice-clock';
import { jsonPath } from '../lib/sql-rows';
import { holdsRunMarker } from '../lib/run-markers';
import type { DerivedPass } from './derived-kind';

export interface DerivedRead { rowid: number; i: number; cell: unknown; inputs: unknown[] }
// changed: the rows whose cell changed (rowids); done: rows worked out, in
// order; filled: cells holding a result now; flagged: rows the kind flagged;
// firstFlag: the first of them, "Row N: …".
export interface DerivedCounts {
  changed: number[]; done: number; filled: number; flagged: number; firstFlag: string | null;
}

const text = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'string' ? v : String(v));

export const inputText = (v: unknown): string => {
  const s = text(v);
  return holdsRunMarker(s) ? '' : s;
};

// The select list reading a row's cell and its inputs ("r." in a join), and its
// parameters in order.
export function derivedSelect(column: string, inputs: string[], alias = ''): { sql: string; params: string[] } {
  const cells = inputs.map((_, k) => `json_extract(${alias}data, ?) AS in${k}`);
  return {
    sql: [`json_extract(${alias}data, ?) AS cell`, ...cells].join(', '),
    params: [jsonPath(column), ...inputs.map(jsonPath)],
  };
}

export function asDerivedRead(row: Record<string, unknown>, inputs: number): DerivedRead {
  return {
    rowid: row.rowid as number, i: row.i as number, cell: row.cell,
    inputs: Array.from({ length: inputs }, (_, k) => row[`in${k}`]),
  };
}

// Rows from a statement (iterated), until maxRows or DERIVED_SLICE_CHARS of
// cell text (always at least one). capped: it stopped before the statement's
// end, so there may be more.
export function readDerivedRows(
  rows: IterableIterator<unknown>, maxRows: number, inputs: number,
): { rows: Array<Record<string, unknown>>; capped: boolean } {
  const out: Array<Record<string, unknown>> = [];
  let chars = 0;
  for (const r of rows as IterableIterator<Record<string, unknown>>) {
    out.push(r);
    chars += text(r.cell).length;
    for (let k = 0; k < inputs; k++) chars += text(r[`in${k}`]).length;
    if (out.length >= maxRows || chars >= DERIVED_SLICE_CHARS) return { rows: out, capped: true };
  }
  return { rows: out, capped: false };
}

// How many rows the next slice reads: about twice what this one worked out,
// up to HEAVY_SLICE_ROWS.
export const pageAfter = (page: number, read: number, done: number): number =>
  (done < read ? Math.max(64, done * 2) : Math.min(HEAVY_SLICE_ROWS, Math.max(page, 64) * 2));

// A fill's slices, timed (BULK_SLICE_MS), read FIRST_TIMED_PAGE rows first, then as many as fit the time at the
// pace of the last slice (`done` rows got through in `ms`), from FIRST_TIMED_PAGE to HEAVY_SLICE_ROWS: rows read
// and worked out but not reached in time are done again in the next slice.
export const FIRST_TIMED_PAGE = 64;
export const pageByTime = (done: number, ms: number): number =>
  Math.max(FIRST_TIMED_PAGE, Math.min(HEAVY_SLICE_ROWS, Math.floor((done * BULK_SLICE_MS) / Math.max(ms, 1))));

// How many queued rows a follow's next slice reads (constants-clean.ts): as many as fit DERIVED_QUEUED_SLICE_FRAMES
// at the frames a row took in the last slice (`read` rows, `frames` written), at most twice `read`, from 64 to
// DERIVED_QUEUED_SLICE_ROWS. None read: `rows` as it was.
export function queuedRowsAfter(rows: number, read: number, frames: number): number {
  if (read === 0) return rows;
  const fit = frames > 0 ? Math.floor((read * DERIVED_QUEUED_SLICE_FRAMES) / frames) : read * 2;
  return Math.max(64, Math.min(DERIVED_QUEUED_SLICE_ROWS, read * 2, fit));
}

// keepWhenEmpty (new rows): a row whose inputs are all empty keeps a cell it
// arrived with, as a person's edit stays until an input changes. began: when
// the slice began reading its rows (sliceClock; left out, now).
export function writeDerivedCells(
  userId: string, cellPath: string, rows: DerivedRead[], pass: DerivedPass,
  opts: { keepWhenEmpty?: boolean; began?: number } = {},
): DerivedCounts {
  const began = opts.began ?? sliceClock();
  const set = db.prepare(`UPDATE rows SET data = json_set(data, ?, ?), updated_at = datetime('now')
    WHERE rowid = ? AND user_id = ?`);
  const unset = db.prepare(`UPDATE rows SET data = json_remove(data, ?), updated_at = datetime('now')
    WHERE rowid = ? AND user_id = ?`);
  const counts: DerivedCounts = { changed: [], done: 0, filled: 0, flagged: 0, firstFlag: null };
  if (pass.failure()) return counts;
  const kept = rows.map(r => !!opts.keepWhenEmpty && text(r.cell) !== '' && r.inputs.length > 0
    && r.inputs.every(v => inputText(v) === ''));
  const cells = pass.compute(rows.filter((_, i) => !kept[i]).map(r => r.inputs), BULK_SLICE_MS / 2);
  let next = 0;
  for (let i = 0; i < rows.length; i++) {
    // Its time is up: the rest go in the next slice.
    if (counts.done > 0 && sliceClock() - began >= BULK_SLICE_MS) break;
    const r = rows[i];
    if (kept[i]) { counts.done++; continue; }
    const out = cells[next++];
    if (!out) break;
    counts.done++;
    if (out.filled) counts.filled++;
    if (out.flag !== undefined) {
      counts.flagged++;
      counts.firstFlag ??= `Row ${r.i + 1}: ${out.flag}`;
    }
    if (out.value === text(r.cell)) continue;
    if (out.value === '') unset.run(cellPath, r.rowid, userId);
    else set.run(cellPath, out.value, r.rowid, userId);
    counts.changed.push(r.rowid);
  }
  return counts;
}
