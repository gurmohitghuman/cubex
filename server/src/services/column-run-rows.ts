// The rows a column run keeps to (services/column-run*.ts), as row places:
// the chosen row ids, or the rows a where matches now, read a page at a time
// (a where can match a million rows; the API thread yields between pages).
import { db } from '../lib/db';
import { yieldToRequests } from '../lib/slices';
import type { WhereItem } from '../lib/row-filter/where';
import { MAX_SELECTED_ROWS } from '../lib/enrich-run-input';
import { prepareWhere } from './row-filter';
import type { RunKind } from './run-controls-column';

const PAGE = 20_000;

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
  const page = db.prepare(`SELECT row_index FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index > ?
    AND (${sql}) ORDER BY row_index LIMIT ?`).pluck();
  const out: number[] = [];
  for (let after = -1; ;) {
    const got = page.all(sheetId, userId, after, ...params, PAGE) as number[];
    for (const i of got) out.push(i);
    if (got.length < PAGE) return out;
    after = got[got.length - 1];
    await yieldToRequests();
  }
}

// An enrichment or a waterfall keeps its chosen rows in its run (at most MAX_SELECTED_ROWS, as the column
// menu's selected rows): a where choosing more is refused for them, in words; null when it fits.
export function selectedRowsProblem(kinds: RunKind[], rows: number): string | null {
  if (rows <= MAX_SELECTED_ROWS || !kinds.some(k => k === 'enrichment' || k === 'waterfall')) return null;
  return `The where matches ${rows.toLocaleString('en-US')} rows, and an enrichment or waterfall column runs on `
    + `at most ${MAX_SELECTED_ROWS.toLocaleString('en-US')} chosen rows at a time. Narrow the where, or run those `
    + 'columns without one.';
}
