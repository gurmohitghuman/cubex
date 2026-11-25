// The rows a column run keeps to (services/column-run*.ts), as row places:
// the chosen row ids, or the rows a where matches now, found a slice of the
// sheet at a time (lib/sheet-slices.ts: a where can match a million rows, or a
// few among a million, and other requests run between slices).
import { db } from '../lib/db';
import { sliceSql, walkSlices, withSlicedRedo } from '../lib/sheet-slices';
import type { WhereItem } from '../lib/row-filter/where';
import { MAX_SELECTED_ROWS } from '../lib/enrich-run-input';
import { prepareWhere } from './row-filter';
import type { RunKind } from './run-controls-column';

export function rowIdPlaces(sheetId: string, userId: string, ids: string[]): number[] {
  return db.prepare(`SELECT row_index FROM rows WHERE sheet_id = ? AND user_id = ?
    AND id IN (SELECT value FROM json_each(?)) ORDER BY row_index`).pluck()
    .all(sheetId, userId, JSON.stringify(ids)) as number[];
}

export async function wherePlaces(
  sheetId: string, userId: string, where: WhereItem[],
): Promise<number[] | { problem: string }> {
  const prepared = prepareWhere(sheetId, userId, where);
  if ('error' in prepared) return { problem: prepared.error };
  const { sql, params } = prepared.ok.filter;
  const inSlice = db.prepare(`SELECT row_index FROM rows WHERE sheet_id = ? AND user_id = ? AND ${sliceSql()}
    AND (${sql}) ORDER BY row_index`).pluck();
  return withSlicedRedo(sheetId, async sliced => {
    const out: number[] = [];
    await walkSlices(sheetId, userId, { sliced }, (lo, hi) => {
      for (const i of inSlice.all(sheetId, userId, lo, hi, ...params) as number[]) out.push(i);
      return false;
    });
    return out;
  });
}

// An enrichment or a waterfall keeps its chosen rows in its run (at most MAX_SELECTED_ROWS, as the column
// menu's selected rows): a where choosing more is refused for them, in words; null when it fits.
export function selectedRowsProblem(kinds: RunKind[], rows: number): string | null {
  if (rows <= MAX_SELECTED_ROWS || !kinds.some(k => k === 'enrichment' || k === 'waterfall')) return null;
  return `The where matches ${rows.toLocaleString('en-US')} rows, and an enrichment or waterfall column runs on `
    + `at most ${MAX_SELECTED_ROWS.toLocaleString('en-US')} chosen rows at a time. Narrow the where, or run those `
    + 'columns without one.';
}
