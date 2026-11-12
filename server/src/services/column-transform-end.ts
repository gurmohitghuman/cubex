// The writes a transform_column call (column-transform.ts) makes once its pages
// end: the cursor its pass's record holds where it stopped, and data_version, so
// open grids and readers learn of what it wrote. Each is written in turn with
// the checkpoint worker's start-over write (lib/wal-turn.ts), as the pages are,
// asking the worker to start the WAL over until `until`, the call's time.
import { db } from '../lib/db';
import { TRANSFORM_SETTLE_RETRY_MS, TRANSFORM_SETTLE_TRIES } from '../lib/api-v1-constants';
import { redactError } from '../lib/redact';
import { inWalTurn, walTurnCheck } from '../lib/wal-turn';
import type { PassTracker } from './column-transform-passes';

// The record's cursor where the call stopped with rows left. If writing it
// fails, the cursor the record already holds (a page's); with none, the call
// fails as any other (it wrote no row).
export async function stopAt(track: PassTracker, after: number, callRows: number, until: number): Promise<string> {
  try {
    const stop = db.transaction(() => { walTurnCheck(); return track.stop(after, callRows); });
    return await inWalTurn(() => stop.immediate(), until, true);
  } catch (error) {
    const held = track.held();
    if (held === null) throw error;
    return held;
  }
}

// data_version after a call, never waiting on this thread: tried with
// busy_timeout 0 (restored after), and refused (another connection holds the
// write lock) tried again TRANSFORM_SETTLE_RETRY_MS later, up to
// TRANSFORM_SETTLE_TRIES times in all, so readers learn of the rows written
// once the lock is let go. A wait for the lock there held the event loop up
// to busy_timeout (5 s) a try. One statement, so it has no first statement to
// check the WAL with once begun (lib/wal-turn.ts): only its read before it.
export async function settle(sheetId: string, userId: string, until: number, tries = 1): Promise<void> {
  try {
    await inWalTurn(() => {
      // Set and put back within the one synchronous write: other writes on this thread keep busy_timeout.
      const wait = db.pragma('busy_timeout', { simple: true }) as number;
      db.pragma('busy_timeout = 0');
      try {
        db.prepare(`UPDATE sheets SET data_version = data_version + 1, updated_at = datetime('now')
          WHERE id = ? AND user_id = ?`).run(sheetId, userId);
      } finally {
        db.pragma(`busy_timeout = ${wait}`);
      }
    }, until, true);
  } catch (error) {
    const again = tries < TRANSFORM_SETTLE_TRIES;
    if (tries === 1 || !again) {
      console.error(`transform_column could not mark sheet ${sheetId} changed${again ? ' (tries again)' : ''}:`,
        redactError(error));
    }
    if (again) {
      setTimeout(() => void settle(sheetId, userId, Date.now(), tries + 1), TRANSFORM_SETTLE_RETRY_MS).unref();
    }
  }
}
