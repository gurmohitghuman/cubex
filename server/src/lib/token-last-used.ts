// An access token's last use (access_tokens.last_used_at, shown in Settings), written without ever holding the
// request that used it or the server's thread. It was written inside token auth, waiting for cubex.db's write lock
// on the server's thread: with every disk sync 300 ms slower, an API call waited about one sync while a run's worker
// committed, and up to busy_timeout (5 s); a write still refused then was dropped, and the throttle kept that use
// from being written at all.
// - Token auth notes the use (noteTokenUse, at most once a token per ACCESS_TOKEN_LAST_USED_WRITE_INTERVAL_MS, as
//   before) and goes on. The write follows on the next turns, one token at a time, as lib/write-when-free.ts makes
//   it: refused while another connection holds the write lock, it is tried again ACCESS_TOKEN_LAST_USED_RETRY_MS
//   later, until it is written.
// - The time written is when the token was used (to the second), not when the write landed. A write never moves
//   last_used_at back, and one for a token deleted meanwhile changes nothing.
// - At shutdown, the uses still waiting are written once, with the usual wait (writeTokenUsesNow).
import { db } from './db';
import { ACCESS_TOKEN_LAST_USED_RETRY_MS } from './constants';
import { writeWhenFree } from './write-when-free';

// Token id → when it was used (ms), not yet written. A use noted while an earlier one waits keeps the earlier.
const uses = writeWhenFree<string, number>({
  what: 'an access token\'s last use', retryMs: ACCESS_TOKEN_LAST_USED_RETRY_MS, keep: 'first',
  write(id, usedAt) {
    const at = Math.floor(usedAt / 1000);
    db.prepare(`UPDATE access_tokens SET last_used_at = datetime(?, 'unixepoch')
      WHERE id = ? AND (last_used_at IS NULL OR last_used_at < datetime(?, 'unixepoch'))`).run(at, id, at);
  },
});

// Token auth: `id` was used now. Its write follows (above).
export function noteTokenUse(id: string, usedAt = Date.now()): void {
  uses.note(id, usedAt);
}

// At shutdown: every use still waiting written now, each with the usual wait for the lock.
export const writeTokenUsesNow = (): void => uses.writeNow();

// Tests only: the uses not yet written.
export const tokenUsesWaiting = (): number => uses.waiting();
