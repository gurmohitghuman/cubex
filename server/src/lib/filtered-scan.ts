// The rows a compiled filter (lib/row-filter/sql.ts) passes, read without
// holding the server: over a million rows, finding them is a scan of the whole
// sheet (about half a second for one condition, more for several), so the
// sheet's rows go a slice at a time in row order, sized to take about
// FILTER_SLICE_MS (lib/constants-filters.ts), slice edges taken from the
// (sheet_id, user_id, row_index) index, and other requests run between slices
// (lib/slices.ts). SQLite checks the filter; rows come back only for the
// page asked for. A heavy operation (a sort, an import, a column rewrite;
// lib/sheet-busy.ts) moves rows between slices, so a scan that overlaps one is
// read again in one go, as SQLite has the rows then (as reads were before
// slicing). Cell edits can land between slices: callers that need one view of
// the sheet compare its row_generation before and after (services/row-selection.ts).
import { db } from './db';
import { sliceSql, walkSlices, withSlicedRedo } from './sheet-slices';
import type { CompiledFilter } from './row-filter/sql';

export interface FilteredScan {
  // Only rows after this row_index (keyset paging). Default: every row.
  after?: number;
  // Leave out the first `skip` passing rows (the grid's offset).
  skip?: number;
  // Passing rows to return, in row order.
  limit: number;
  // Also count every passing row after `after` (the whole scan, then).
  count?: boolean;
}

export async function scanFiltered<T>(
  sheetId: string, userId: string, filter: CompiledFilter, scan: FilteredScan, select = 'id, row_index, data',
): Promise<{ rows: T[]; count: number | null }> {
  return withSlicedRedo(sheetId, sliced => scanOnce<T>(sheetId, userId, filter, scan, select, sliced));
}

// sliced false: no yields, so the whole scan runs between two of a heavy operation's slices.
async function scanOnce<T>(
  sheetId: string, userId: string, filter: CompiledFilter, scan: FilteredScan, select: string, sliced: boolean,
): Promise<{ rows: T[]; count: number | null }> {
  const inSlice = `sheet_id = ? AND user_id = ? AND ${sliceSql()} AND (${filter.sql})`;
  const countIn = db.prepare(`SELECT COUNT(*) FROM rows WHERE ${inSlice}`).pluck();
  const pageIn = db.prepare(`SELECT ${select} FROM rows WHERE ${inSlice} ORDER BY row_index LIMIT ? OFFSET ?`);
  const rows: T[] = [];
  let skip = scan.skip ?? 0, count = 0;
  await walkSlices(sheetId, userId, { from: scan.after, sliced }, (lo, hi) => {
    const slice = [sheetId, userId, lo, hi, ...filter.params];
    const need = scan.limit - rows.length;
    if (scan.count || (need > 0 && skip > 0)) {
      const n = countIn.get(...slice) as number;
      count += n;
      if (need > 0 && n <= skip) skip -= n;
      else if (need > 0) { rows.push(...pageIn.all(...slice, need, skip) as T[]); skip = 0; }
    } else if (need > 0) {
      rows.push(...pageIn.all(...slice, need, 0) as T[]);
    }
    return !scan.count && rows.length >= scan.limit;
  });
  return { rows, count: scan.count ? count : null };
}
