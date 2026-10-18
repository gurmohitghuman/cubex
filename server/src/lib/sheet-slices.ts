// A walk over one sheet's rows in row order, a slice at a time, without
// holding the server: each slice is sized to take about FILTER_SLICE_MS
// (lib/constants-filters.ts), its edges come from the (sheet_id, user_id,
// row_index) index, and other requests run between slices (lib/slices.ts).
// Filtered reads (lib/filtered-scan.ts), search (services/sheet-search.ts) and
// aggregates (services/row-aggregate.ts) walk this way. A heavy operation (a
// sort, an import, a column rewrite; lib/sheet-busy.ts) moves rows between
// slices: a filtered read that overlaps one is done again in one go
// (withSlicedRedo), counts answer busy (slicedUnlessBusy), and search walks on.
import { db } from './db';
import { yieldToRequests } from './slices';
import { busyEpoch, busyMessage, sheetBusyWith } from './sheet-busy';
import { FILTER_SLICE_MAX_ROWS, FILTER_SLICE_MIN_ROWS, FILTER_SLICE_MS, FILTER_SLICE_ROWS } from './constants-filters';

export interface SliceWalk {
  // Start after this row_index (or before it, going down). Default: the first (or last) row.
  from?: number;
  desc?: boolean;
  // false: no yields, the whole walk runs between two slices of a heavy operation.
  sliced: boolean;
  // Asked between slices; true ends the walk (the asker went away).
  stop?: () => boolean;
}

// A slice's rows as a condition: `row_index > ? AND row_index <= ?` going up,
// `row_index >= ? AND row_index < ?` going down; visit binds (a, b) in that order.
export const sliceSql = (desc = false): string =>
  (desc ? 'row_index >= ? AND row_index < ?' : 'row_index > ? AND row_index <= ?');

const edgeUp = () => db.prepare(`SELECT row_index FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index > ?
  ORDER BY row_index LIMIT 1 OFFSET ?`).pluck();
const edgeDown = () => db.prepare(`SELECT row_index FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index < ?
  ORDER BY row_index DESC LIMIT 1 OFFSET ?`).pluck();

// Calls visit with each slice's bounds until it returns true (done), the rows
// run out, or stop() says so. Returns false when stop() ended it.
export async function walkSlices(
  sheetId: string, userId: string, walk: SliceWalk, visit: (a: number, b: number) => boolean,
): Promise<boolean> {
  const edge = walk.desc ? edgeDown() : edgeUp();
  let size = FILTER_SLICE_ROWS;
  let at = walk.from ?? (walk.desc ? Number.MAX_SAFE_INTEGER : Number.MIN_SAFE_INTEGER);
  for (;;) {
    const started = performance.now();
    // Up: the slice is (at, next]. Down: [next, at). `size` rows, or the rest.
    const next = edge.get(sheetId, userId, at, size - 1) as number | undefined;
    const end = next ?? (walk.desc ? Number.MIN_SAFE_INTEGER : Number.MAX_SAFE_INTEGER);
    const done = walk.desc ? visit(end, at) : visit(at, end);
    if (done || next === undefined) return true;
    at = next;
    const took = performance.now() - started;
    if (took > FILTER_SLICE_MS) size = Math.max(FILTER_SLICE_MIN_ROWS, Math.floor(size / 2));
    else if (took < FILTER_SLICE_MS / 4) size = Math.min(FILTER_SLICE_MAX_ROWS, size * 2);
    if (walk.sliced) await yieldToRequests();
    if (walk.stop?.()) return false;
  }
}

// Runs `attempt` sliced; when a heavy operation ran on the sheet meanwhile (or
// is running), runs it again unsliced, as SQLite has the rows then. `attempt`
// must start from scratch each time.
export async function withSlicedRedo<T>(sheetId: string, attempt: (sliced: boolean) => Promise<T>): Promise<T> {
  const epoch = busyEpoch(sheetId);
  if (!sheetBusyWith(sheetId)) {
    const out = await attempt(true);
    if (!sheetBusyWith(sheetId) && busyEpoch(sheetId) === epoch) return out;
  }
  return attempt(false);
}

// For counts (aggregates, value counts): sliced, but never over rows a heavy
// operation is moving and never read again in one go (a million rows grouped
// at once hold the server for seconds). While one runs, or when one ran
// meanwhile, the answer is its busy message: try again once it's done.
export async function slicedUnlessBusy<T>(sheetId: string, attempt: () => Promise<T>): Promise<T | { busy: string }> {
  const running = sheetBusyWith(sheetId);
  if (running) return { busy: busyMessage(running) };
  const epoch = busyEpoch(sheetId);
  const out = await attempt();
  const now = sheetBusyWith(sheetId);
  if (now || busyEpoch(sheetId) !== epoch) return { busy: busyMessage(now ?? 'moving rows') };
  return out;
}
