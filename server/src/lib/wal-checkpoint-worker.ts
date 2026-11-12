// The WAL checkpoint worker thread (started by lib/wal-checkpointer.ts): its own
// connection to the database, opened by lib/db.ts as the API thread's is (the
// same file and settings), copies the WAL back into the database file when
// asked, so the disk sync that ends a checkpoint never holds the API thread.
// One request at a time, each answered with SQLite's own numbers: `busy` (it
// couldn't run, another checkpoint held the lock), the frames in the WAL and the
// frames copied. PASSIVE never waits for a lock: what a reader still reads stays
// in the WAL until a later checkpoint. 'close' closes the connection and ends
// the thread.
//
// A checkpoint that left every frame copied (an empty WAL too) starts the WAL over here, before its answer
// (`startOver`). SQLite starts it over in the first write that began with every frame copied, and that write syncs
// the WAL's new header to disk inside its commit (synchronous=NORMAL); a write into an empty WAL writes and syncs
// its header too. Made by the API thread, a transform_column page after each of its waits, that sync held the
// event loop for as long as a slow disk takes. The write here rewrites user_version with the value it holds (the
// database header's page; nothing Cubex reads changes), in the worker's turn (TURN in lib/wal-shared.ts):
// 'turn', a transform_column write on the API thread holds it, so it isn't tried (that write asks for another
// checkpoint, lib/wal-turn.ts); tried once without waiting for the write lock, 'busy' while another connection
// holds it. 'reader': a reader still on the old frames kept SQLite from starting over, and the write added a frame,
// which the next checkpoint copies. 'read-only': the connection can't write (PRAGMA query_only, or a file it can't
// write); skipped quietly, the checkpoint's numbers as they were. 'done': started over. On a read-only database
// file the checkpoint itself fails first (and the worker may not start: lib/db.ts's PRAGMA optimize writes).
import { parentPort, workerData } from 'worker_threads';
import { db } from './db';
import { FREE, HELD, HOLD_MS, READ_ONLY, TURN, WORKER, walShared } from './wal-shared';

export type CheckpointAsk = { id: number; delayMs: number } | 'close';
export type StartOver = 'done' | 'reader' | 'turn' | 'busy' | 'read-only' | 'failed';
export type CheckpointReply = {
  id: number; busy: number; log: number; checkpointed: number; startOver?: StartOver; error?: string;
};

const shared: Int32Array = (workerData as { shared?: Int32Array } | null)?.shared ?? walShared;
// Tests only: wait this long before a checkpoint, as a slow disk would (the API thread is never held by it).
const pause = new Int32Array(new SharedArrayBuffer(4));

type WalNow = { log: number; checkpointed: number };
const walNow = () => (db.pragma('wal_checkpoint(NOOP)') as WalNow[])[0];
const rewrite = db.transaction(() => {
  // Tests only: held here, the write lock taken.
  const ms = Atomics.load(shared, HOLD_MS);
  if (ms > 0) {
    Atomics.store(shared, HELD, 1);
    try { Atomics.wait(shared, HOLD_MS, ms, ms); } finally { Atomics.store(shared, HELD, 0); }
  }
  db.pragma(`user_version = ${Number(db.pragma('user_version', { simple: true }))}`);
});
// undefined: a write since the checkpoint left frames uncopied, nothing to start over.
function startOver(): StartOver | undefined {
  if (Atomics.compareExchange(shared, TURN, FREE, WORKER) !== FREE) return 'turn';
  try {
    const before = walNow();
    if (!before || before.log < 0 || before.checkpointed < before.log) return undefined;
    const wait = db.pragma('busy_timeout', { simple: true }) as number;
    const readOnly = Atomics.load(shared, READ_ONLY) === 1;
    db.pragma('busy_timeout = 0');
    if (readOnly) db.pragma('query_only = ON');
    try {
      rewrite.immediate();
    } catch (err) {
      const code = String((err as { code?: string })?.code ?? '');
      if (code === 'SQLITE_BUSY') return 'busy';
      if (code.startsWith('SQLITE_READONLY')) return 'read-only';
      console.error('Starting the WAL over failed:', err);
      return 'failed';
    } finally {
      if (readOnly) db.pragma('query_only = OFF');
      db.pragma(`busy_timeout = ${wait}`);
    }
    // Started over, the WAL holds that write's frame (and any written since), fewer than before.
    return before.log === 0 || (walNow()?.log ?? before.log + 1) <= before.log ? 'done' : 'reader';
  } finally {
    Atomics.compareExchange(shared, TURN, WORKER, FREE);
  }
}

parentPort?.on('message', (ask: CheckpointAsk) => {
  if (ask === 'close') {
    try { db.close(); } finally { process.exit(0); }
  }
  if (ask.delayMs > 0) Atomics.wait(pause, 0, 0, ask.delayMs);
  let reply: CheckpointReply;
  try {
    const [r] = db.pragma('wal_checkpoint(PASSIVE)') as Array<Omit<CheckpointReply, 'id'>>;
    reply = { id: ask.id, busy: r.busy, log: r.log, checkpointed: r.checkpointed };
    if (r.busy === 0 && r.log >= 0 && r.checkpointed === r.log) reply.startOver = startOver();
  } catch (err) {
    reply = { id: ask.id, busy: 1, log: -1, checkpointed: -1, error: String((err as Error)?.message ?? err) };
  }
  parentPort!.postMessage(reply);
});
parentPort?.postMessage('ready');
