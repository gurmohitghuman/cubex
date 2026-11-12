// The writes a transform_column call (column-transform.ts) makes once its pages
// end: the cursor its pass's record holds where it stopped, and data_version, so
// open grids and readers learn of what it wrote.
import { db } from '../lib/db';
import { TRANSFORM_SETTLE_RETRY_MS, TRANSFORM_SETTLE_TRIES } from '../lib/api-v1-constants';
import { redactError } from '../lib/redact';
import type { PassTracker } from './column-transform-passes';

// The record's cursor where the call stopped with rows left. If writing it
// fails, the cursor the record already holds (a page's); with none, the call
// fails as any other (it wrote no row).
export function stopAt(track: PassTracker, after: number, callRows: number): string {
  try {
    return db.transaction(() => track.stop(after, callRows)).immediate();
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
// to busy_timeout (5 s) a try.
export function settle(sheetId: string, userId: string, tries = 1): void {
  const wait = db.pragma('busy_timeout', { simple: true }) as number;
  db.pragma('busy_timeout = 0');
  try {
    db.prepare(`UPDATE sheets SET data_version = data_version + 1, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?`).run(sheetId, userId);
  } catch (error) {
    const again = tries < TRANSFORM_SETTLE_TRIES;
    if (tries === 1 || !again) {
      console.error(`transform_column could not mark sheet ${sheetId} changed${again ? ' (tries again)' : ''}:`,
        redactError(error));
    }
    if (again) setTimeout(() => settle(sheetId, userId, tries + 1), TRANSFORM_SETTLE_RETRY_MS).unref();
  } finally {
    db.pragma(`busy_timeout = ${wait}`);
  }
}
