// Slices sized by the bytes of the rows they rewrite, move or delete (HEAVY_SLICE_BYTES, lib/constants.ts), not
// only by how many: SQLite writes a changed row's whole record again, so a slice of rows holding big cells (an API
// answer in each) wrote past the WAL's cap in one commit. Each writer reads its next rows' sizes with
// octet_length(data), which SQLite answers from the row's header without reading its pages, then takes as many as
// withinBytes says.
import { db } from './db';

// How many of `sizes` (each row's bytes, in slice order) fit `budget`: at least one, so a row bigger than the
// budget still goes, alone.
export function withinBytes(sizes: ArrayLike<number | null>, budget: number): number {
  let total = 0;
  for (let i = 0; i < sizes.length; i++) {
    total += sizes[i] ?? 0;
    if (total > budget && i > 0) return i;
  }
  return sizes.length;
}

// The first of `pairs` ([key, bytes], in slice order) that fit `budget`: their keys.
export const keysWithinBytes = <K>(pairs: Array<[K, number | null]>, budget: number): K[] =>
  pairs.slice(0, withinBytes(pairs.map(p => p[1]), budget)).map(p => p[0]);

// The bytes of every row with lo <= rowid <= hi: a slice's rows in storage order, and any other sheet's between
// them (so never less than the slice holds). One pass over the range: about 0.3 ms for 5,000 rows, against about
// 1 ms looking each up by rowid, so a walk reads each row's size only when this is past its budget.
export const rangeBytes = (lo: number, hi: number): number => db.prepare(`SELECT IFNULL(SUM(octet_length(data)), 0)
  FROM rows WHERE rowid BETWEEN ? AND ?`).pluck().get(lo, hi) as number;

// Each of `ids`' rows' bytes, in `ids`' order (0 for a row gone).
export function rowBytes(ids: ArrayLike<number>, idsJson: string): number[] {
  const got = new Map(db.prepare(`SELECT rowid, octet_length(data) FROM rows
    WHERE rowid IN (SELECT value FROM json_each(?))`).raw().all(idsJson) as Array<[number, number | null]>);
  return Array.from(ids, id => got.get(id) ?? 0);
}
