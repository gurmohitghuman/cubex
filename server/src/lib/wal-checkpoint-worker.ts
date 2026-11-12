// The WAL checkpoint worker thread (started by lib/wal-checkpointer.ts): its own
// connection to the database, opened by lib/db.ts as the API thread's is (the
// same file and settings), copies the WAL back into the database file when
// asked, so the disk sync that ends a checkpoint never holds the API thread.
// One request at a time, each answered with SQLite's own numbers: `busy` (it
// couldn't run, another checkpoint held the lock), the frames in the WAL and the
// frames copied. PASSIVE never waits for a lock: what a reader still reads stays
// in the WAL until a later checkpoint. 'close' closes the connection and ends
// the thread.
import { parentPort } from 'worker_threads';
import { db } from './db';

export type CheckpointAsk = { id: number; delayMs: number } | 'close';
export type CheckpointReply = { id: number; busy: number; log: number; checkpointed: number; error?: string };

// Tests only: wait this long before a checkpoint, as a slow disk would (the API thread is never held by it).
const pause = new Int32Array(new SharedArrayBuffer(4));

parentPort?.on('message', (ask: CheckpointAsk) => {
  if (ask === 'close') {
    try { db.close(); } finally { process.exit(0); }
  }
  if (ask.delayMs > 0) Atomics.wait(pause, 0, 0, ask.delayMs);
  let reply: CheckpointReply;
  try {
    const [r] = db.pragma('wal_checkpoint(PASSIVE)') as Array<Omit<CheckpointReply, 'id'>>;
    reply = { id: ask.id, busy: r.busy, log: r.log, checkpointed: r.checkpointed };
  } catch (err) {
    reply = { id: ask.id, busy: 1, log: -1, checkpointed: -1, error: String((err as Error)?.message ?? err) };
  }
  parentPort!.postMessage(reply);
});
parentPort?.postMessage('ready');
