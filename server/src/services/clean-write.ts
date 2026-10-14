// Writing cleaned cells, for the fill (clean-fill.ts) and auto-run
// (clean-follow.ts) alike. Call inside the transaction that read the rows. A
// cell is written only when its value changes, and an empty result removes
// the key (a missing key is an empty cell), so cleaning a row again changes
// nothing and queues nothing for the auto-runs that read the column. A source
// holding a run's own words (⏳, ❌, ⏭️, ➕) is empty, never data to clean:
// "⏭️ Not found" must not become the last name "Found".
import { db } from '../lib/db';
import { holdsRunMarker } from '../lib/run-markers';

export interface CleanCellRead { rowid: number; source: unknown; cell: unknown }
// changed: the rows whose cell changed (rowids); filled: cells holding a value
// now; blanked: source values the cleaner couldn't read (cleaned to empty).
export interface CleanCounts { changed: number[]; filled: number; blanked: number }

const text = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'string' ? v : String(v));

export const sourceText = (v: unknown): string => {
  const s = text(v);
  return holdsRunMarker(s) ? '' : s;
};

// keepWhenEmpty: a row whose source is empty keeps its clean cell (a new row
// that arrived with that cell filled), as a person's edit stays until the
// source changes.
export function writeCleanCells(
  userId: string, cellPath: string, rows: CleanCellRead[], clean: (value: string) => string,
  opts: { keepWhenEmpty?: boolean } = {},
): CleanCounts {
  const set = db.prepare('UPDATE rows SET data = json_set(data, ?, ?) WHERE rowid = ? AND user_id = ?');
  const unset = db.prepare('UPDATE rows SET data = json_remove(data, ?) WHERE rowid = ? AND user_id = ?');
  const counts: CleanCounts = { changed: [], filled: 0, blanked: 0 };
  for (const r of rows) {
    const source = sourceText(r.source);
    if (source === '' && opts.keepWhenEmpty) continue;
    const value = source === '' ? '' : clean(source);
    if (value !== '') counts.filled++;
    else if (/\S/.test(source)) counts.blanked++;
    if (value === text(r.cell)) continue;
    if (value === '') unset.run(cellPath, r.rowid, userId);
    else set.run(cellPath, value, r.rowid, userId);
    counts.changed.push(r.rowid);
  }
  return counts;
}
