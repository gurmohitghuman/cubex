// Long jobs over a million rows run as many short slices: each call to `step`
// does a bounded amount of work (one short transaction, well under 100 ms) and
// returns true while there is more. Between slices the event loop serves other
// requests, so a sort or an import never freezes the server, and SQLite's write
// lock is released often enough for other writers (autosave, webhooks, run
// workers) to get in.
import { db } from './db';

export async function runInSlices(step: () => boolean): Promise<void> {
  while (step()) await yieldToRequests();
}

// Writers on the server's thread have their slices' WAL copied back on the checkpoint worker's thread instead
// (lib/bulk-slices.ts): a commit that leaves the WAL at SQLite's own mark copies it back inside it, disk syncs and
// all, while requests wait. Plain slices are for reads and for other threads, which checkpoint their own connection
// (tests/unit/bulk-wal-guard.test.ts lists every loop that yields).

// Runs `work` (a transaction) with SQLite's own WAL checkpoint off, so its
// commit can't run one; the caller has the WAL copied back otherwise.
export function withoutAutoCheckpoint<T>(work: () => T): T {
  const auto = db.pragma('wal_autocheckpoint', { simple: true }) as number;
  db.pragma('wal_autocheckpoint = 0');
  try {
    return work();
  } finally {
    db.pragma(`wal_autocheckpoint = ${auto}`);
  }
}

// `work` in one transaction: its own, the write lock taken first (a read before the first write can't then fail with
// SQLITE_BUSY), or the one it is called in, flat. A bulk writer's slice is one already (lib/bulk-slices.ts), and a
// transaction nested in it is a savepoint: while one is open, SQLite keeps every statement's pages in its statement
// journal until it ends (past 64 KB, in a temp file), so 5,000 one-row updates took about 450 ms instead of 33.
// Flat, a failure part way leaves what `work` wrote until the outer transaction rolls back: let it propagate.
export function oneTransaction<T>(work: () => T): T {
  return db.inTransaction ? work() : db.transaction(work).immediate();
}

// Let requests that queued up meanwhile run before the next slice.
export function yieldToRequests(): Promise<void> {
  return new Promise<void>(resolve => setImmediate(resolve));
}
