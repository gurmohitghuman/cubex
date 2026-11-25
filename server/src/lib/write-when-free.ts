// Small writes made after the fact, never holding the server's thread for cubex.db's write lock: an access token's
// last use (lib/token-last-used.ts) and a sheet's last row count (lib/row-counts.ts). Waiting for the lock on the
// server's thread held it about one disk sync while a run's worker committed, and up to busy_timeout (5 s).
// - A write is noted (one per key) and goes on the next turns, one key at a time.
// - Each write is tried with busy_timeout 0 (restored after): refused while another connection holds the write
//   lock, it is kept and tried again `retryMs` later, until it is written. It is taken in turn with the checkpoint
//   worker (lib/wal-turn.ts), so it never starts the WAL over here, and with SQLite's own checkpoint off
//   (lib/slices.ts), so it never copies the WAL back here either. With no worker, it goes on as other writes do.
// - `keep`: a key noted again while it waits keeps its first value, or takes the last.
// - At shutdown, the writes still waiting are made once, with the usual wait (writeNow).
import { db } from './db';
import { withoutAutoCheckpoint } from './slices';
import { inWalTurn, walTurnCheck } from './wal-turn';

export interface WhenFree<K, V> {
  note(key: K, value: V): void;
  writeNow(): void;
  // Tests only: the writes not yet made.
  waiting(): number;
}

const busy = (err: unknown): boolean =>
  String((err as { code?: unknown } | null)?.code ?? '').startsWith('SQLITE_BUSY');

// `write` runs inside the write's transaction. `what` names it in the log.
export function writeWhenFree<K, V>(opts: {
  what: string; retryMs: number; keep: 'first' | 'last'; write: (key: K, value: V) => void;
}): WhenFree<K, V> {
  // In the order noted.
  const waiting = new Map<K, V>();
  let timer: NodeJS.Timeout | null = null;
  let writing = false;

  // Written: true. Refused (the lock held, or the worker's turn past a moment): false.
  async function tryWrite(key: K, value: V): Promise<boolean> {
    const tx = db.transaction(() => { walTurnCheck(); opts.write(key, value); });
    try {
      const out = await inWalTurn(() => withoutAutoCheckpoint(() => {
        // Set and put back within the one synchronous write: other writes on this thread keep busy_timeout.
        const wait = db.pragma('busy_timeout', { simple: true }) as number;
        db.pragma('busy_timeout = 0');
        try { tx.immediate(); } finally { db.pragma(`busy_timeout = ${wait}`); }
      }), Date.now() + opts.retryMs);
      return out !== 'late';
    } catch (err) {
      if (busy(err)) return false;
      // Anything else would fail again: logged, and the write dropped.
      console.error(`Writing ${opts.what} failed:`, err);
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
      for (const [key, value] of [...waiting]) {
        if (!await tryWrite(key, value)) { refused = true; break; }
        // A newer value noted while this one was written stays for the next turn.
        if (waiting.get(key) === value) waiting.delete(key);
      }
    } finally {
      writing = false;
      schedule(refused ? opts.retryMs : 0);
    }
  }

  return {
    note(key, value) {
      if (opts.keep === 'last' || !waiting.has(key)) {
        // Taking the last moves it to the end, after the keys noted since.
        if (opts.keep === 'last') waiting.delete(key);
        waiting.set(key, value);
      }
      schedule(0);
    },
    writeNow() {
      if (timer) { clearTimeout(timer); timer = null; }
      for (const [key, value] of [...waiting]) {
        try {
          db.transaction(() => opts.write(key, value)).immediate();
        } catch (err) {
          console.error(`Writing ${opts.what} at shutdown failed:`, err);
        }
        waiting.delete(key);
      }
    },
    waiting: () => waiting.size,
  };
}
