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

// Slices that dirty pages all over the database (an undo, moves into and out of the trash, emptying it) have
// their WAL copied back on the checkpoint worker's thread instead: lib/bulk-slices.ts.

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

// Let requests that queued up meanwhile run before the next slice.
export function yieldToRequests(): Promise<void> {
  return new Promise<void>(resolve => setImmediate(resolve));
}
