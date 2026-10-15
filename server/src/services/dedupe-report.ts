// What a duplicate check or removal answers: the counts, and a few groups
// with their key cells as written, so a person (or an agent) can see what
// "duplicate" meant before anything goes. Read before the rows are deleted.
import { db } from '../lib/db';
import { jsonPath } from '../lib/sql-helpers';
import { DEDUPE_SAMPLE_CHARS } from '../lib/constants-dedupe';
import type { FinderResult, FoundGroup, FoundRow } from '../lib/dedupe/finder';
import type { DedupeKey, DedupeKeep } from '../lib/dedupe/key';
import type { DedupeRequest } from './dedupe-input';

// row: the 1-based position the grid shows; values: the key cells.
export interface SampleRow { id: string; row: number; values: Record<string, string> }
export interface SampleGroup { kept: SampleRow; removed: SampleRow[]; size: number }

export interface DedupeReport {
  keys: DedupeKey[];
  keep: DedupeKeep;
  rowsChecked: number;
  duplicateRows: number; // the rows that go
  groups: number;
  emptyKeyRows: number;
  samples: SampleGroup[];
  // The largest group when it is bigger than 2 and not a sample already: a
  // key like "n/a" shared by thousands of rows shows up here.
  largest: SampleGroup | null;
}

const cellText = (v: unknown): string =>
  (v === null || v === undefined ? '' : String(v)).slice(0, DEDUPE_SAMPLE_CHARS);

export function dedupeReport(
  sheetId: string, userId: string, req: DedupeRequest, found: FinderResult,
): DedupeReport {
  const largest = found.largest && found.largest.size > 2
    && !found.samples.some(g => g.kept.rowid === found.largest!.kept.rowid) ? found.largest : null;
  const groups = largest ? [...found.samples, largest] : found.samples;
  const rowids = groups.flatMap(g => [g.kept.rowid, ...g.removed.map(r => r.rowid)]);
  const read = rowids.length === 0 ? [] : db.prepare(`SELECT rowid, id,
      ${req.keys.map(() => 'json_extract(data, ?)').join(', ')} FROM rows
    WHERE rowid IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?`).raw()
    .all(...req.keys.map(k => jsonPath(k.column)), JSON.stringify(rowids), sheetId, userId) as unknown[][];
  const byRowid = new Map(read.map(r => [r[0] as number, r]));
  const rowOf = (f: FoundRow): SampleRow => {
    const r = byRowid.get(f.rowid);
    const values: Record<string, string> = {};
    req.keys.forEach((k, j) => { values[k.column] = cellText(r?.[2 + j]); });
    return { id: (r?.[1] as string | undefined) ?? '', row: f.position, values };
  };
  const group = (g: FoundGroup): SampleGroup => ({ kept: rowOf(g.kept), removed: g.removed.map(rowOf), size: g.size });
  return {
    keys: req.keys, keep: req.keep,
    rowsChecked: found.rows, duplicateRows: found.remove.length, groups: found.groups,
    emptyKeyRows: found.emptyKeyRows,
    samples: found.samples.map(group), largest: largest ? group(largest) : null,
  };
}
