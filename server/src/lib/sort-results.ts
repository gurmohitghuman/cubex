import { db } from './db';
import { HEAVY_SLICE_ROWS } from './constants';
import { yieldToRequests } from './slices';
import type { PositionMap } from './sort-plan';

// After a physical sort (services/sheet-sort.ts), stored results must follow
// their rows: ai_results and http_results point at a row by row_index (the
// preview-commit writes cells by it; the scraped-sources popup keys on it).
// Two steps, each in slices between requests and each safe to redo after a
// restart (lib/sort-plan.ts journals which one is under way):
//   park — every result moves above any real position (row_index + PARK), so
//          mapping can't collide with a result not yet visited under
//          http_results' UNIQUE(run_id, row_index);
//   map  — every parked result moves to its row's new position. A result whose
//          row no longer exists is deleted: it points at nothing, and kept at
//          its old position it would attach to whichever row lands there.
const PARK = 2 ** 40;

export async function parkResults(sheetId: string, userId: string): Promise<void> {
  for (const table of ['ai_results', 'http_results'] as const) {
    const park = db.prepare(`UPDATE ${table} SET row_index = row_index + ? WHERE rowid = ? AND row_index < ?`);
    // A negative position is the orphan marker earlier sorts left: no row.
    const drop = db.prepare(`DELETE FROM ${table} WHERE rowid = ?`);
    await eachSlice(table, sheetId, userId, rows => {
      for (const [rid, at] of rows) {
        if (at < 0) drop.run(rid); else if (at < PARK) park.run(PARK, rid, PARK);
      }
    });
  }
}

export async function mapResults(sheetId: string, userId: string, map: PositionMap): Promise<void> {
  const newPosition = (old: number): number | null => {
    let lo = 0, hi = map.olds.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (map.olds[mid] === old) return map.news[mid];
      if (map.olds[mid] < old) lo = mid + 1; else hi = mid - 1;
    }
    return null;
  };
  for (const table of ['ai_results', 'http_results'] as const) {
    const set = db.prepare(`UPDATE ${table} SET row_index = ? WHERE rowid = ?`);
    const drop = db.prepare(`DELETE FROM ${table} WHERE rowid = ?`);
    await eachSlice(table, sheetId, userId, rows => {
      for (const [rid, at] of rows) {
        if (at < PARK) continue;
        const next = newPosition(at - PARK);
        if (next === null) drop.run(rid); else set.run(next, rid);
      }
    });
  }
}

// The sheet's results, HEAVY_SLICE_ROWS at a time in rowid order, each slice in
// one transaction. `+run_id` keeps SQLite walking the table in rowid order
// instead of sorting every matching row for each slice.
async function eachSlice(
  table: 'ai_results' | 'http_results', sheetId: string, userId: string,
  apply: (rows: Array<[number, number]>) => void,
): Promise<void> {
  const slice = (table === 'ai_results'
    ? db.prepare(`
      SELECT rowid, row_index FROM ai_results
      WHERE +run_id IN (SELECT id FROM ai_runs WHERE sheet_id = ? AND user_id = ?) AND rowid > ?
      ORDER BY rowid LIMIT ?`)
    : db.prepare(`
      SELECT rowid, row_index FROM http_results
      WHERE +run_id IN (SELECT id FROM http_runs WHERE sheet_id = ? AND user_id = ?) AND rowid > ?
      ORDER BY rowid LIMIT ?`)
  ).raw();
  for (let after = 0; ;) {
    const rows = slice.all(sheetId, userId, after, HEAVY_SLICE_ROWS) as Array<[number, number]>;
    if (rows.length === 0) return;
    db.transaction(() => apply(rows))();
    after = rows[rows.length - 1][0];
    await yieldToRequests();
  }
}
