// Each sheet's row count, for the home (GET /api/tables) and for GET /v1/tables and list_tables, without counting
// rows on a request: COUNT(*) over 10 sheets of 1M rows held the server's thread 1.2 to 1.4 s on every home load.
// - A count is kept in memory with the sheet's marker when it was made: its data_version, row_generation and how
//   often its rows were added to or removed on this server (lib/rows-changed.ts). Every row insert and delete moves
//   one of them, so a count whose marker still holds is exact, and no write pays anything for it.
// - A sheet whose marker moved shows its last count, marked as updating, and is counted again: in slices of
//   ROW_COUNT_SLICE_ROWS rows on the server's thread, letting other work run between them, one sheet at a time.
//   Rows changed during a count make it count again (up to ROW_COUNT_TRIES in all).
// - A heavy operation (lib/sheet-busy.ts: a sort, an import, a column delete) moves rows in slices between requests
//   and moves the marker only when it ends, so a count that overlaps one proves nothing, as for lib/column-repair.ts:
//   the sheet stays queued, shown as updating, and is counted once it is free, using none of its tries.
// - The last count is also kept in sheets.counted_rows (migration 063), written when a count lands and only if it
//   changed, never by a row write, and without waiting for the write lock (lib/write-when-free.ts). After a restart
//   nothing in memory holds, so each sheet shows that count as updating, and is counted again when asked for.
import { db } from './db';
import { rowsChangedOf } from './rows-changed';
import { busyEpoch, onSheetFree, sheetBusyWith } from './sheet-busy';
import { writeWhenFree } from './write-when-free';
import { ROW_COUNT_SLICE_ROWS, ROW_COUNT_TRIES, ROW_COUNT_WRITE_RETRY_MS } from './constants-row-counts';

// What a caller reads from sheets for each sheet it shows (COUNT_COLUMNS).
export interface CountedSheet { id: string; data_version: number; row_generation: number; counted_rows: number }
export const COUNT_COLUMNS = 'data_version, row_generation, counted_rows';
// `updating`: a count of the sheet is queued or being made; `rows` is then its last count.
export interface RowCount { rows: number; updating: boolean }

interface Queued { sheetId: string; userId: string; stored: number }
const known = new Map<string, { rows: number; marker: string }>();
const queue: Queued[] = [];
// Sheets queued or being counted.
const counting = new Set<string>();
let running = false;
const waiters = new Set<() => void>();
let sliceRows = ROW_COUNT_SLICE_ROWS;
let afterSlice: (() => void | Promise<void>) | null = null;

const stored = writeWhenFree<string, { userId: string; rows: number }>({
  what: 'a sheet\'s row count', retryMs: ROW_COUNT_WRITE_RETRY_MS, keep: 'last',
  write(sheetId, c) {
    db.prepare('UPDATE sheets SET counted_rows = ? WHERE id = ? AND user_id = ?').run(c.rows, sheetId, c.userId);
  },
});

const markerOf = (sheetId: string, dataVersion: number, rowGeneration: number): string =>
  `${dataVersion}:${rowGeneration}:${rowsChangedOf(sheetId)}`;

function markerNow(sheetId: string, userId: string): string | null {
  const s = db.prepare('SELECT data_version, row_generation FROM sheets WHERE id = ? AND user_id = ?')
    .get(sheetId, userId) as { data_version: number; row_generation: number } | undefined;
  return s ? markerOf(sheetId, s.data_version, s.row_generation) : null;
}

const MIN_INDEX = Number.MIN_SAFE_INTEGER;
async function countRows(sheetId: string, userId: string): Promise<number> {
  // The rows' unique index (sheet_id, user_id, row_index) covers it: each slice reads the next rows in order.
  const slice = db.prepare(`SELECT COUNT(*) AS n, MAX(row_index) AS last FROM (SELECT row_index FROM rows
    WHERE sheet_id = ? AND user_id = ? AND row_index > ? ORDER BY row_index LIMIT ?)`);
  let rows = 0;
  let after = MIN_INDEX;
  for (;;) {
    const r = slice.get(sheetId, userId, after, sliceRows) as { n: number; last: number | null };
    rows += r.n;
    if (r.n < sliceRows) return rows;
    after = r.last!;
    await afterSlice?.();
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

// 'busy': a heavy operation runs on the sheet, or ran during the count and still does; it is counted once free.
async function count(q: Queued): Promise<'counted' | 'busy'> {
  for (let tries = 1; ;) {
    if (sheetBusyWith(q.sheetId) !== null) return 'busy';
    const epoch = busyEpoch(q.sheetId);
    const marker = markerNow(q.sheetId, q.userId);
    if (marker === null) { known.delete(q.sheetId); return 'counted'; }
    const rows = await countRows(q.sheetId, q.userId);
    // One came and went during the count: the sheet is free now, so it is counted again at once.
    if (sheetBusyWith(q.sheetId) !== null || busyEpoch(q.sheetId) !== epoch) continue;
    if (markerNow(q.sheetId, q.userId) !== marker && tries < ROW_COUNT_TRIES) { tries++; continue; }
    // With its marker from before: one that moved meanwhile leaves the sheet to be counted again when asked.
    known.set(q.sheetId, { rows, marker });
    if (rows !== q.stored) stored.note(q.sheetId, { userId: q.userId, rows });
    return 'counted';
  }
}

const start = () => { if (!running && queue.length > 0) setImmediate(() => void run()); };

async function run(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (let q = queue.shift(); q; q = queue.shift()) {
      let busy = false;
      try { busy = (await count(q)) === 'busy'; }
      catch (err) { console.error('Counting a sheet\'s rows failed:', err); }
      finally {
        // Still queued, out of the line: the other sheets are counted meanwhile.
        if (busy) onSheetFree(q.sheetId, () => { queue.push(q); start(); });
        else counting.delete(q.sheetId);
        for (const w of [...waiters]) w();
      }
    }
  } finally { running = false; }
}

const shown = (s: { id: string; counted_rows: number }): RowCount =>
  ({ rows: known.get(s.id)?.rows ?? s.counted_rows, updating: counting.has(s.id) });

// The counts of a user's sheets now, counting nothing on this thread: a sheet whose rows may have changed since
// its last count is queued to be counted again. `first`: before the sheets already queued (an agent's call waits).
export function rowCounts(userId: string, sheets: CountedSheet[], first = false): Map<string, RowCount> {
  const out = new Map<string, RowCount>();
  const ahead: Queued[] = [];
  for (const s of sheets) {
    const k = known.get(s.id);
    if (k && k.marker === markerOf(s.id, s.data_version, s.row_generation)) {
      out.set(s.id, { rows: k.rows, updating: false });
      continue;
    }
    const q = { sheetId: s.id, userId, stored: s.counted_rows };
    if (!counting.has(s.id)) { counting.add(s.id); (first ? ahead : queue).push(q); }
    else if (first) {
      const at = queue.findIndex(x => x.sheetId === s.id);
      if (at >= 0) ahead.push(...queue.splice(at, 1));
    }
    out.set(s.id, shown(s));
  }
  queue.unshift(...ahead);
  // On the next turn: the request that asked answers first.
  start();
  return out;
}

// The counts now of sheets shown before, queuing none.
export function rowCountsNow(sheets: Array<{ id: string; counted_rows: number }>): Map<string, RowCount> {
  return new Map(sheets.map(s => [s.id, shown(s)]));
}

// Resolves once none of `ids` is queued or being counted, or at `until` (ms) at the latest.
export async function countsMade(ids: string[], until: number): Promise<void> {
  while (ids.some(id => counting.has(id))) {
    const left = until - Date.now();
    if (left <= 0) return;
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(cap); waiters.delete(done); resolve(); };
      // The caller's limit: an answer never waits past it.
      const cap = setTimeout(done, left);
      waiters.add(done);
    });
  }
}

// At shutdown: the counts not yet written to sheets.counted_rows, written now.
export const writeRowCountsNow = (): void => stored.writeNow();

// Tests only.
export const rowCountWritesWaiting = (): number => stored.waiting();
export function forgetRowCounts(): void { known.clear(); }
// `hook` runs after each slice but the last, before the count goes on (a test writes rows, or holds the count).
export function setRowCountSlices(rows: number, hook: (() => void | Promise<void>) | null = null): void {
  sliceRows = rows;
  afterSlice = hook;
}
