// transform_column's walk over the sheet (services/column-transform.ts), in row
// order from the cursor: a page of TRANSFORM_PAGE_ROWS rows at a time, each
// page read, worked out and written in one short immediate transaction, the
// server answering other requests between pages (lib/slices.ts). Each page
// commits with SQLite's own WAL checkpoint off (left on, it ran inside about
// one page commit in fifty and copied 2,000 frames back there, holding the
// server), and the WAL is copied back on the checkpoint worker's thread
// (lib/wal-checkpointer.ts) once enough of it waits: a checkpoint after every
// page, on this thread, held the server about 50 ms each on a slow disk. Past
// its bound the walk waits for the worker before a page, and stops there, as at
// its time limit, when the call's time runs out first or, past its first page,
// when a reader holds the frames the worker would copy (lib/wal-checkpointer.ts).
// Each page is written in turn with the worker's write that starts the WAL over
// (lib/wal-turn.ts): it never waits for that write, nor starts the WAL over
// itself; one that would asks the worker to and awaits it, within the call's
// time, past which it stops as after a wait. A page that wrote nothing doesn't
// grow the WAL. One page of rows is in memory at a time, whatever the sheet's
// size. A page first reads its window off the (sheet_id,
// user_id, row_index) index, then only the rows in that window that pass
// `where`: a where that matches nothing still looks at one window a page, never
// the rest of the sheet in one statement. The call stops before a page once it
// has written TRANSFORM_MAX_ROWS rows or worked TRANSFORM_MAX_CALL_MS (waits
// for the worker included); every page before that is written and stays
// written. A page that fails ends the walk: the pages before it stay written,
// and the walk answers how far they got. A walk with `prepare` (regex_extract)
// reads each page once before its transaction too, in row order, and has the
// values worked out off this thread from those rows (lib/transform-regex-host.ts):
// the transaction then only looks them up. When the time a page has for that runs
// out, the page ends after the rows worked out, and the next starts at the row
// that was running; the transaction writes them though the call's time ran out
// meanwhile (it was checked before the page). A row changed in between has no
// value, so the page writes nothing and is read again, at most PREPARE_TRIES times
// in a row.
import { db } from '../lib/db';
import {
  TRANSFORM_MAX_ROWS, TRANSFORM_PAGE_ROWS, TRANSFORM_QUEUED_ROWS,
} from '../lib/api-v1-constants';
import { jsonPath, parseRowData } from '../lib/sql-helpers';
import { autorunReaderCount, markAutorunInputs } from '../lib/autorun-mark';
import { withoutAutoCheckpoint, yieldToRequests } from '../lib/slices';
import { walRoom, walSettle } from '../lib/wal-checkpointer';
import { inWalTurn, walTurnCheck } from '../lib/wal-turn';
import type { CompiledFilter } from '../lib/row-filter/sql';
import type { PassTracker } from './column-transform-passes';

export interface TransformWalk {
  sheetId: string; userId: string; filter: CompiledFilter; targetColumn: string;
  // The target's new value for a row, from its cells; undefined when `prepare`
  // didn't work it out (the row changed since it read the page).
  value: (data: Record<string, string>) => string | undefined;
  // Works out the values of a page's rows (in row order) before the page's transaction; answers how many, from
  // the first, it worked out, at least one. Fewer: the page ends after those.
  prepare?: (rows: PageRow[]) => Promise<number>;
  // The row_index the walk starts after (the cursor's; -1 from the top).
  after: number;
  // When the call's time runs out (ms since the epoch).
  until: number;
  // The pass's record (column-transform-passes.ts): written in each page's
  // transaction once its rows are, told once the page committed.
  track: PassTracker;
}

export interface PageRow { id: string; data: Record<string, string> }

// Rows written and pages committed, and the last row_index looked at when the
// call stopped with rows left (null: it got to the end of the sheet). `failed`:
// a page failed; stoppedAfter is then where the pages committed before it got.
export type WalkResult =
  | { updated: number; pages: number; stoppedAfter: number | null; failed?: undefined }
  | { updated: number; pages: number; stoppedAfter: number; failed: { error: unknown } };

const PREPARE_TRIES = 3;

export async function walkTransform(w: TransformWalk): Promise<WalkResult> {
  // With columns following the target, a page queues each row it writes for each
  // of them: it is sized by the rows it queues.
  const readers = autorunReaderCount(w.sheetId, w.userId, [w.targetColumn]);
  const pageRows = readers === 0 ? TRANSFORM_PAGE_ROWS
    : Math.max(1, Math.min(TRANSFORM_PAGE_ROWS, Math.floor(TRANSFORM_QUEUED_ROWS / (1 + readers))));
  const windowEnd = db.prepare(`SELECT row_index FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index > ?
    ORDER BY row_index LIMIT 1 OFFSET ?`).pluck();
  const read = db.prepare(`SELECT rowid AS rid, data FROM rows WHERE sheet_id = ? AND user_id = ?
    AND row_index > ? AND row_index <= ? AND (${w.filter.sql}) ORDER BY rowid`);
  const readInOrder = db.prepare(`SELECT id, row_index AS ri, data FROM rows WHERE sheet_id = ? AND user_id = ?
    AND row_index > ? AND row_index <= ? AND (${w.filter.sql}) ORDER BY row_index`);
  const set = db.prepare("UPDATE rows SET data = json_set(data, ?, ?), updated_at = datetime('now') WHERE rowid = ?");
  const path = jsonPath(w.targetColumn);
  let after = w.after;
  let updated = 0;
  let pages = 0;
  let done = false;
  let wrote = false;
  let wroteAny = false;
  let unprepared = 0;
  // The last row_index in the window of at most `rows` rows after `after` (undefined: the sheet ends in it).
  const windowLast = (rows: number) => windowEnd.get(w.sheetId, w.userId, after, rows - 1) as number | undefined;
  // The page's rows up to `last`, the window's or the one its prepare got to.
  const window = (last: number | undefined) => ({ last, found: read.all(w.sheetId, w.userId, after,
    last ?? Number.MAX_SAFE_INTEGER, ...w.filter.params) as Array<{ rid: number; data: string }> });
  // What a page did, taken over only once it committed: a page that fails leaves the walk where it was.
  const page = db.transaction((rows: number, end: number | undefined) => {
    walTurnCheck();
    const { last, found } = window(end ?? windowLast(rows));
    const values = found.map(r => w.value(parseRowData(r.data)));
    if (values.includes(undefined)) return { again: true as const };
    found.forEach((r, i) => set.run(path, values[i], r.rid));
    // A column another column's auto-run reads queues these rows for it.
    markAutorunInputs(w.sheetId, w.userId, [w.targetColumn], { rowids: found.map(r => r.rid) });
    const tracked = w.track.page(last ?? null, updated + found.length, found.length);
    return { found: found.length, last, wrote: found.length > 0 || tracked };
  });
  // `prepared`: the page's values were worked out, ending after row_index `end` when not every row got one.
  const step = (prepared: false | { end?: number }): boolean => {
    wrote = false;
    const room = TRANSFORM_MAX_ROWS - updated;
    if (room <= 0 || (!prepared && Date.now() >= w.until)) return false;
    // A page never looks at more rows than the call may still write.
    const p = page.immediate(Math.min(pageRows, room), prepared ? prepared.end : undefined);
    if ('again' in p) {
      if (++unprepared >= PREPARE_TRIES) {
        throw new Error(`A page's rows changed ${PREPARE_TRIES} times between working out and writing their values.`);
      }
      return true;
    }
    unprepared = 0;
    w.track.committed();
    updated += p.found;
    pages++;
    wrote = p.wrote;
    wroteAny ||= p.wrote;
    if (p.last === undefined) done = true;
    else after = p.last;
    return !done;
  };
  try {
    for (let first = true, more = true; more; first = false) {
      // Only a page that wrote grew the WAL, and the call before may have stopped with it past its bound. The
      // call's time running out in the wait stops it before any page, its first too; a reader holding the frames
      // stops it only after its first page, so each call goes on.
      if (wrote || first) {
        const room = await walRoom(w.until);
        if (room === 'late' || (room === 'held' && !first)) break;
      }
      let prepared: false | { end?: number } = false;
      if (w.prepare) {
        const room = TRANSFORM_MAX_ROWS - updated;
        if (room <= 0 || Date.now() >= w.until) break;
        const last = windowLast(Math.min(pageRows, room));
        const rows = readInOrder.all(w.sheetId, w.userId, after, last ?? Number.MAX_SAFE_INTEGER,
          ...w.filter.params) as Array<{ id: string; ri: number; data: string }>;
        const worked = await w.prepare(rows.map(r => ({ id: r.id, data: parseRowData(r.data) })));
        prepared = { end: worked < rows.length ? rows[worked - 1].ri : undefined };
      }
      const went = await inWalTurn(() => withoutAutoCheckpoint(() => step(prepared)), w.until, prepared !== false);
      if (went === 'late') break;
      more = went;
      await yieldToRequests();
    }
  } catch (error) {
    return { updated, pages, stoppedAfter: after, failed: { error } };
  } finally {
    if (wroteAny) walSettle();
  }
  return { updated, pages, stoppedAfter: done ? null : after };
}
