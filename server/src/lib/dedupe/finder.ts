// Which rows go when duplicates are removed (pure). Rows arrive in sheet
// order with their key (lib/dedupe/key.ts) and, for "most complete", how many
// cells they fill. One row of each key stays: the first, the last, or the one
// filling the most cells (the highest of those that tie). Memory is one map
// entry per distinct key plus the rowids to remove, so a million rows fit.
import type { DedupeKeep } from './key';
import { DEDUPE_SAMPLE_GROUPS, DEDUPE_SAMPLE_REMOVED } from '../constants-dedupe';

// A row by rowid and its 1-based position in the sheet (what the grid numbers it).
export interface FoundRow { rowid: number; position: number }
export interface FoundGroup { kept: FoundRow; removed: FoundRow[]; size: number }

export interface FinderResult {
  rows: number;
  emptyKeyRows: number;
  groups: number;
  remove: Float64Array; // rowids, ascending
  samples: FoundGroup[];
  largest: FoundGroup | null; // its kept row and size only
}

export class DuplicateFinder {
  private readonly slotOf = new Map<string, number>();
  // Per key (its slot): the row staying so far, its position and filled cells, and the group size.
  private readonly winRowid: number[] = [];
  private readonly winPos: number[] = [];
  private readonly winFilled: number[] = [];
  private readonly size: number[] = [];
  private readonly remove: number[] = [];
  // The first groups found, with their first members (rowid, position pairs).
  private readonly sampled = new Map<number, number[]>();
  private rows = 0;
  private empty = 0;

  constructor(
    private readonly keep: DedupeKeep,
    private readonly sampleGroups = DEDUPE_SAMPLE_GROUPS,
    private readonly sampleRemoved = DEDUPE_SAMPLE_REMOVED,
  ) {}

  add(rowid: number, position: number, key: string | null, filled: number): void {
    this.rows++;
    if (key === null) { this.empty++; return; }
    const s = this.slotOf.get(key);
    if (s === undefined) {
      this.slotOf.set(key, this.size.length);
      this.winRowid.push(rowid); this.winPos.push(position); this.winFilled.push(filled); this.size.push(1);
      return;
    }
    if (++this.size[s] === 2 && this.sampled.size < this.sampleGroups) {
      this.sampled.set(s, [this.winRowid[s], this.winPos[s]]);
    }
    // Enough members to list sampleRemoved removed rows whichever one stays.
    const members = this.sampled.get(s);
    if (members && members.length < (this.sampleRemoved + 2) * 2) members.push(rowid, position);
    const replaces = this.keep === 'last' || (this.keep === 'most_complete' && filled > this.winFilled[s]);
    if (!replaces) { this.remove.push(rowid); return; }
    this.remove.push(this.winRowid[s]);
    this.winRowid[s] = rowid; this.winPos[s] = position; this.winFilled[s] = filled;
  }

  result(): FinderResult {
    let groups = 0, big = -1;
    for (let s = 0; s < this.size.length; s++) {
      if (this.size[s] < 2) continue;
      groups++;
      if (big < 0 || this.size[s] > this.size[big]) big = s;
    }
    const kept = (s: number): FoundRow => ({ rowid: this.winRowid[s], position: this.winPos[s] });
    const samples: FoundGroup[] = [];
    for (const [s, m] of this.sampled) {
      const removed: FoundRow[] = [];
      for (let i = 0; i < m.length && removed.length < this.sampleRemoved; i += 2) {
        if (m[i] !== this.winRowid[s]) removed.push({ rowid: m[i], position: m[i + 1] });
      }
      samples.push({ kept: kept(s), removed, size: this.size[s] });
    }
    return {
      rows: this.rows, emptyKeyRows: this.empty, groups,
      remove: Float64Array.from(this.remove).sort(),
      samples,
      largest: big < 0 ? null : { kept: kept(big), removed: [], size: this.size[big] },
    };
  }
}
