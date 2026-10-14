// Writing a derived column's cells (derived-kind.ts), for the fill
// (derived-fill.ts) and auto-run's follow (derived-follow.ts) alike. Call
// inside the transaction that read the rows. A cell is written only when its
// value changes, and an empty result removes the key (a missing key is an
// empty cell), so working a row out again changes nothing and queues nothing
// for the auto-runs that read the column. The pass works out as many rows as
// fit DERIVED_SLICE_MS (at least one; none when it must be prepared again):
// `done` says how many rows the slice got through, in order, and the caller
// moves its cursor that far. Reading stops at DERIVED_SLICE_CHARS, and the
// next slice reads about twice what the last one worked out (pageAfter), so
// rows a slice didn't reach are never read many times over. An input holding a
// run's own words (⏳, ❌, ⏭️, ➕) is empty, never data: "⏭️ Not found" must not
// become the last name "Found".
import { db } from '../lib/db';
import { DERIVED_SLICE_CHARS, DERIVED_SLICE_MS, HEAVY_SLICE_ROWS } from '../lib/constants';
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

// keepWhenEmpty (new rows): a row whose inputs are all empty keeps a cell it
// arrived with, as a person's edit stays until an input changes.
export function writeDerivedCells(
  userId: string, cellPath: string, rows: DerivedRead[], pass: DerivedPass,
  opts: { keepWhenEmpty?: boolean } = {},
): DerivedCounts {
  const set = db.prepare('UPDATE rows SET data = json_set(data, ?, ?) WHERE rowid = ? AND user_id = ?');
  const unset = db.prepare('UPDATE rows SET data = json_remove(data, ?) WHERE rowid = ? AND user_id = ?');
  const counts: DerivedCounts = { changed: [], done: 0, filled: 0, flagged: 0, firstFlag: null };
  if (pass.failure()) return counts;
  const kept = rows.map(r => !!opts.keepWhenEmpty && text(r.cell) !== '' && r.inputs.length > 0
    && r.inputs.every(v => inputText(v) === ''));
  const cells = pass.compute(rows.filter((_, i) => !kept[i]).map(r => r.inputs), DERIVED_SLICE_MS);
  let next = 0;
  for (let i = 0; i < rows.length; i++) {
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
