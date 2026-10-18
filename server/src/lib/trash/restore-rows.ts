// Putting a trash batch's rows back into their sheet, a slice at a time
// (services/trash-restore.ts runs it, with the sheet busy).
//
// Where they go: their old places when the sheet's rows haven't been
// reordered since (no sort, CSV replace or duplicate removal: row_generation
// is the one the batch kept) and none of those places is taken now; otherwise
// the end of the sheet, in the order they had. A row keeps its stable id
// unless a row has it now. Its cells come back under the sheet's columns: the
// same name in any case, or the column added again at the end (as many as the
// column limit leaves room for; the rest are left out and named). A cell a
// run was filling ("⏳ ...") comes back empty.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db';
import { MAX_COLUMNS_PER_SHEET, TRASH_PLACE_CHECK_ROWS } from '../constants';
import { yieldToRequests } from '../slices';
import { appendColumnsToOrder, getSheetColumns } from '../sql-helpers';
import { nextRowIndex } from '../sheet-busy';
import { RUNNING_MARK } from '../run-markers';
import type { TrashItem } from './store';

export interface ColumnPlan { map: Map<string, string>; added: string[]; dropped: string[] }

export const batchColumns = (item: TrashItem): string[] => {
  try {
    const v = JSON.parse(item.columns);
    return Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string') : [];
  } catch { return []; }
};

// The batch's columns the sheet doesn't have (in any case), and its room for more.
export function missingColumns(sheetId: string, userId: string, item: TrashItem): { missing: string[]; room: number } {
  const current = getSheetColumns(sheetId, userId, false);
  const have = new Set(current.map(c => c.toLowerCase()));
  const missing: string[] = [];
  for (const c of batchColumns(item)) {
    if (!have.has(c.toLowerCase())) { have.add(c.toLowerCase()); missing.push(c); }
  }
  return { missing, room: Math.max(0, MAX_COLUMNS_PER_SHEET - current.length) };
}

// The batch's columns as the sheet has them, adding the missing ones. Call
// inside a transaction; calling it again (a restart going on) adds nothing new.
export function planColumns(sheetId: string, userId: string, item: TrashItem): ColumnPlan {
  const current = getSheetColumns(sheetId, userId, false);
  const byLower = new Map(current.map(c => [c.toLowerCase(), c]));
  const map = new Map<string, string>();
  const missing: string[] = [];
  for (const c of batchColumns(item)) {
    const have = byLower.get(c.toLowerCase());
    if (have) map.set(c, have);
    else if (!missing.some(m => m.toLowerCase() === c.toLowerCase())) missing.push(c);
  }
  const room = Math.max(0, MAX_COLUMNS_PER_SHEET - current.length);
  const added = missing.slice(0, room);
  if (added.length > 0) appendColumnsToOrder(sheetId, userId, added);
  for (const c of added) map.set(c, c);
  return { map, added, dropped: missing.slice(room) };
}

// Whether every one of the rows (all of the batch, or the picked seqs) may go
// back to its old place: the sheet's rows weren't reordered since, and no row
// sits there now. A whole batch is read TRASH_PLACE_CHECK_ROWS rows at a time,
// letting other requests in between.
export async function oldPlacesFree(
  item: TrashItem, sheetId: string, userId: string, picks: number[] | null,
): Promise<boolean> {
  const gen = db.prepare('SELECT row_generation FROM sheets WHERE id = ? AND user_id = ?').pluck()
    .get(sheetId, userId) as number | undefined;
  if (gen === undefined || item.row_generation === null || gen !== item.row_generation) return false;
  if (picks) {
    return db.prepare(`SELECT EXISTS (SELECT 1 FROM trash_rows t JOIN rows r ON r.sheet_id = ? AND r.user_id = ?
        AND r.row_index = t.row_index WHERE t.item_id = ? AND t.seq IN (SELECT value FROM json_each(?)))`)
      .pluck().get(sheetId, userId, item.id, JSON.stringify(picks)) === 0;
  }
  const edge = db.prepare(`SELECT seq FROM trash_rows WHERE item_id = ? AND seq > ? ORDER BY seq
    LIMIT 1 OFFSET ?`).pluck();
  const taken = db.prepare(`SELECT EXISTS (SELECT 1 FROM trash_rows t JOIN rows r ON r.sheet_id = ? AND r.user_id = ?
      AND r.row_index = t.row_index WHERE t.item_id = ? AND t.seq > ? AND t.seq <= ?)`).pluck();
  for (let after = 0; ;) {
    const end = edge.get(item.id, after, TRASH_PLACE_CHECK_ROWS - 1) as number | undefined;
    if (taken.get(sheetId, userId, item.id, after, end ?? Number.MAX_SAFE_INTEGER) !== 0) return false;
    if (end === undefined) return true;
    after = end;
    await yieldToRequests();
  }
}

function cellsBack(json: string, plan: ColumnPlan): string {
  let cells: unknown;
  try { cells = JSON.parse(json); } catch { cells = {}; }
  const out: Record<string, unknown> = {};
  if (cells && typeof cells === 'object' && !Array.isArray(cells)) {
    for (const [k, v] of Object.entries(cells as Record<string, unknown>)) {
      const to = plan.map.get(k);
      if (to === undefined || (typeof v === 'string' && v.startsWith(RUNNING_MARK))) continue;
      out[to] = v;
    }
  }
  return JSON.stringify(out);
}

interface TrashRow { seq: number; row_index: number; row_id: string; data: string }

// One transaction: up to `limit` of the batch's rows (in order, or the picked
// ones) go back, leave the batch, and count as restored. Returns how many.
export function restoreSlice(
  itemId: number, sheetId: string, userId: string, plan: ColumnPlan, limit: number, picks: number[] | null,
): number {
  let n = 0;
  db.transaction(() => {
    const item = db.prepare('SELECT restore_at, restored FROM trash_items WHERE id = ?').get(itemId) as
      { restore_at: number | null; restored: number };
    const list = picks ? JSON.stringify(picks) : null;
    const rows = db.prepare(`SELECT seq, row_index, row_id, data FROM trash_rows WHERE item_id = ?
      AND (? IS NULL OR seq IN (SELECT value FROM json_each(?))) ORDER BY seq LIMIT ?`)
      .all(itemId, list, list, limit) as TrashRow[];
    if (rows.length === 0) return;
    const insert = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, ?, ?)');
    const idTaken = db.prepare('SELECT 1 FROM rows WHERE id = ?').pluck();
    const placeTaken = db.prepare('SELECT 1 FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index = ?').pluck();
    let bytes = 0;
    const ids: string[] = [];
    rows.forEach((r, k) => {
      let at = item.restore_at === null ? r.row_index : item.restore_at + item.restored + k;
      // A place taken after all (a row resurrected by a stale tab): the end.
      if (item.restore_at === null && placeTaken.get(sheetId, userId, at)) at = nextRowIndex(sheetId, userId);
      const id = idTaken.get(r.row_id) ? uuidv4() : r.row_id;
      insert.run(id, sheetId, userId, at, cellsBack(r.data, plan));
      ids.push(id);
      bytes += Buffer.byteLength(r.data, 'utf8');
    });
    // Clean, formula and lookup columns work restored rows out again (their
    // columns may have changed meanwhile). Rows at the end are new to them;
    // rows back at old places, under their fence, are queued (the auto-run
    // sweep takes them once the sheet is free).
    if (item.restore_at === null) {
      db.prepare(`INSERT OR IGNORE INTO autorun_pending (autorun_id, user_id, row_id)
        SELECT e.id, e.user_id, j.value FROM autorun_columns e, json_each(?) j
        WHERE e.sheet_id = ? AND e.user_id = ? AND e.enabled = 1 AND e.kind IN ('clean', 'formula', 'lookup')`)
        .run(JSON.stringify(ids), sheetId, userId);
    }
    db.prepare('DELETE FROM trash_rows WHERE item_id = ? AND seq IN (SELECT value FROM json_each(?))')
      .run(itemId, JSON.stringify(rows.map(r => r.seq)));
    db.prepare(`UPDATE trash_items SET restored = restored + ?, row_count = row_count - ?,
      bytes = MAX(0, bytes - ?) WHERE id = ?`).run(rows.length, rows.length, bytes, itemId);
    n = rows.length;
  })();
  return n;
}
