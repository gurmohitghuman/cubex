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
import { yieldToRequests } from './slices';
import { busyEpoch, sheetBusyWith } from './sheet-busy';
import {
  FILTER_SLICE_MAX_ROWS, FILTER_SLICE_MIN_ROWS, FILTER_SLICE_MS, FILTER_SLICE_ROWS,
} from './constants-filters';
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
  const epoch = busyEpoch(sheetId);
  if (!sheetBusyWith(sheetId)) {
    const sliced = await scanOnce<T>(sheetId, userId, filter, scan, select, true);
    if (!sheetBusyWith(sheetId) && busyEpoch(sheetId) === epoch) return sliced;
  }
  return scanOnce<T>(sheetId, userId, filter, scan, select, false);
}

// sliced false: no yields, so the whole scan runs between two of a heavy operation's slices.
async function scanOnce<T>(
  sheetId: string, userId: string, filter: CompiledFilter, scan: FilteredScan, select: string, sliced: boolean,
): Promise<{ rows: T[]; count: number | null }> {
  const edge = db.prepare(`SELECT row_index FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index > ?
    ORDER BY row_index LIMIT 1 OFFSET ?`).pluck();
  const inSlice = `sheet_id = ? AND user_id = ? AND row_index > ? AND row_index <= ? AND (${filter.sql})`;
  const countIn = db.prepare(`SELECT COUNT(*) FROM rows WHERE ${inSlice}`).pluck();
  const pageIn = db.prepare(`SELECT ${select} FROM rows WHERE ${inSlice} ORDER BY row_index LIMIT ? OFFSET ?`);
  const rows: T[] = [];
  let skip = scan.skip ?? 0, count = 0, size = FILTER_SLICE_ROWS;
  for (let lo = scan.after ?? Number.MIN_SAFE_INTEGER; ;) {
    const started = performance.now();
    // The slice is (lo, next]: `size` rows, or the rest of the sheet.
    const next = edge.get(sheetId, userId, lo, size - 1) as number | undefined;
    const slice = [sheetId, userId, lo, next ?? Number.MAX_SAFE_INTEGER, ...filter.params];
    const need = scan.limit - rows.length;
    if (scan.count || (need > 0 && skip > 0)) {
      const n = countIn.get(...slice) as number;
      count += n;
      if (need > 0 && n <= skip) skip -= n;
      else if (need > 0) { rows.push(...pageIn.all(...slice, need, skip) as T[]); skip = 0; }
    } else if (need > 0) {
      rows.push(...pageIn.all(...slice, need, 0) as T[]);
    }
    if (next === undefined || (!scan.count && rows.length >= scan.limit)) break;
    lo = next;
    const took = performance.now() - started;
    if (took > FILTER_SLICE_MS) size = Math.max(FILTER_SLICE_MIN_ROWS, Math.floor(size / 2));
    else if (took < FILTER_SLICE_MS / 4) size = Math.min(FILTER_SLICE_MAX_ROWS, size * 2);
    if (sliced) await yieldToRequests();
  }
  return { rows, count: scan.count ? count : null };
}
