// When the user last opened a table in the app (tables.last_opened_at, migration 064: the home's Recent tab),
// written without holding the server's thread for cubex.db's write lock (lib/write-when-free.ts): the table page
// notes the open as its first rows show, which may be while a run's worker commits.
// - POST /api/tables/:id/opened notes it (noteTableOpened) and answers at once. The write follows on the next turns;
//   refused while another connection holds the write lock, it is tried again TABLE_OPENED_RETRY_MS later, until it
//   is written. A table opened again while its write waits keeps the later time.
// - The time written is when the table was opened, to the millisecond, so two opened in the same second keep their
//   order. A write never moves it back, and one for a table trashed or deleted meanwhile changes nothing.
// - At shutdown, the opens still waiting are written once, with the usual wait (writeTableOpensNow).
import { db } from './db';
import { TABLE_OPENED_RETRY_MS } from './constants';
import { writeWhenFree } from './write-when-free';

// Table id → who opened it and when (ms), not yet written.
const opens = writeWhenFree<string, { userId: string; at: number }>({
  what: 'when a table was last opened', retryMs: TABLE_OPENED_RETRY_MS, keep: 'last',
  write(id, { userId, at }) {
    db.prepare(`UPDATE tables SET last_opened_at = strftime('%Y-%m-%d %H:%M:%f', ?, 'unixepoch')
      WHERE id = ? AND user_id = ? AND trash_id IS NULL AND hidden = 0
        AND (last_opened_at IS NULL OR last_opened_at < strftime('%Y-%m-%d %H:%M:%f', ?, 'unixepoch'))`)
      .run(at / 1000, id, userId, at / 1000);
  },
});

// The table page: the user opened table `id` now. Its write follows (above).
export function noteTableOpened(userId: string, id: string, at = Date.now()): void {
  opens.note(id, { userId, at });
}

// At shutdown: every open still waiting written now, each with the usual wait for the lock.
export const writeTableOpensNow = (): void => opens.writeNow();

// Tests only: the opens not yet written.
export const tableOpensWaiting = (): number => opens.waiting();
