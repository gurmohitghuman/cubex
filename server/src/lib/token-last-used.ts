// An access token's last use (access_tokens.last_used_at, shown in Settings), written without ever holding the
// request that used it or the server's thread. It was written inside token auth, waiting for cubex.db's write lock
// on the server's thread: with every disk sync 300 ms slower, an API call waited about one sync while a run's worker
// committed, and up to busy_timeout (5 s); a write still refused then was dropped, and the throttle kept that use
// from being written at all.
// - Token auth notes the use (noteTokenUse, at most once a token per ACCESS_TOKEN_LAST_USED_WRITE_INTERVAL_MS, as
//   before) and goes on. The write follows on the next turns, one token at a time.
// - Each write is tried with busy_timeout 0 (restored after): refused while another connection holds the write
//   lock, the use is kept and tried again ACCESS_TOKEN_LAST_USED_RETRY_MS later, until it is written. It is taken in
//   turn with the checkpoint worker (lib/wal-turn.ts), so it never starts the WAL over here, and with SQLite's own
//   checkpoint off (lib/slices.ts), so it never copies the WAL back here either. With no worker, it goes on as
//   other writes do.
// - The time written is when the token was used (to the second), not when the write landed. A write never moves
//   last_used_at back, and one for a token deleted meanwhile changes nothing.
// - At shutdown, the uses still waiting are written once, with the usual wait (writeTokenUsesNow).
import { db } from './db';
import { ACCESS_TOKEN_LAST_USED_RETRY_MS } from './constants';
import { withoutAutoCheckpoint } from './slices';
import { inWalTurn, walTurnCheck } from './wal-turn';

// Token id → when it was used (ms), not yet written. In the order noted.
const waiting = new Map<string, number>();
let timer: NodeJS.Timeout | null = null;
let writing = false;

const busy = (err: unknown): boolean =>
  String((err as { code?: unknown } | null)?.code ?? '').startsWith('SQLITE_BUSY');
function write(id: string, usedAt: number): void {
  const at = Math.floor(usedAt / 1000);
  db.prepare(`UPDATE access_tokens SET last_used_at = datetime(?, 'unixepoch')
    WHERE id = ? AND (last_used_at IS NULL OR last_used_at < datetime(?, 'unixepoch'))`).run(at, id, at);
}

// Written: true. Refused (the lock held, or the worker's turn past a moment): false.
async function tryWrite(id: string, usedAt: number): Promise<boolean> {
  const tx = db.transaction(() => { walTurnCheck(); write(id, usedAt); });
  try {
    const out = await inWalTurn(() => withoutAutoCheckpoint(() => {
      // Set and put back within the one synchronous write: other writes on this thread keep busy_timeout.
      const wait = db.pragma('busy_timeout', { simple: true }) as number;
      db.pragma('busy_timeout = 0');
      try { tx.immediate(); } finally { db.pragma(`busy_timeout = ${wait}`); }
    }), Date.now() + ACCESS_TOKEN_LAST_USED_RETRY_MS);
    return out !== 'late';
  } catch (err) {
    if (busy(err)) return false;
    // Anything else would fail again: logged, and the use dropped, as a failed write was before.
    console.error('Writing an access token\'s last use failed:', err);
    return true;
  }
}

function schedule(ms: number): void {
  if (timer || writing || waiting.size === 0) return;
  timer = setTimeout(() => { timer = null; void writeWaiting(); }, ms);
  timer.unref();
}

async function writeWaiting(): Promise<void> {
  writing = true;
  let refused = false;
  try {
    for (const [id, usedAt] of [...waiting]) {
      if (!await tryWrite(id, usedAt)) { refused = true; break; }
      waiting.delete(id);
    }
  } finally {
    writing = false;
    schedule(refused ? ACCESS_TOKEN_LAST_USED_RETRY_MS : 0);
  }
}

// Token auth: `id` was used now. Its write follows (above); a use noted while an earlier one waits keeps the earlier.
export function noteTokenUse(id: string, usedAt = Date.now()): void {
  if (!waiting.has(id)) waiting.set(id, usedAt);
  schedule(0);
}

// At shutdown: every use still waiting written now, each with the usual wait for the lock.
export function writeTokenUsesNow(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  for (const [id, usedAt] of [...waiting]) {
    try {
      db.transaction(() => write(id, usedAt)).immediate();
    } catch (err) {
      console.error('Writing an access token\'s last use at shutdown failed:', err);
    }
    waiting.delete(id);
  }
}

// Tests only: the uses not yet written.
export const tokenUsesWaiting = (): number => waiting.size;
