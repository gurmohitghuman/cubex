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

// As runInSlices, with a PASSIVE WAL checkpoint after each slice, a turn
// later: for jobs whose slices dirty pages all over the database (moving rows
// with random ids in and out of the trash, deleting them for good). Left to
// SQLite's own checkpoint at 2,000 pages, one commit now and then copied
// megabytes back and held the server for a second or more; small slices with
// their own checkpoint stay at a few ms each (lib/constants-trash.ts).
export async function runInCheckpointedSlices(step: () => boolean): Promise<void> {
  while (step()) {
    await yieldToRequests();
    db.pragma('wal_checkpoint(PASSIVE)');
    await yieldToRequests();
  }
}

// As runInCheckpointedSlices, for slices that may each dirty about as many
// pages as SQLite's own checkpoint waits for (2,000, lib/db.ts), or more: that
// one is off while a slice runs, so it never copies the WAL back inside the
// slice's commit, and the last slice is checkpointed too, so the next commit,
// whoever makes it, doesn't inherit its pages (lib/placeholder-cells.ts).
export async function runInCheckpointedRowSlices(step: () => boolean): Promise<void> {
  for (let more = true; more;) {
    more = withoutAutoCheckpoint(step);
    await yieldToRequests();
    db.pragma('wal_checkpoint(PASSIVE)');
    await yieldToRequests();
  }
}

// Runs `work` (a transaction) with SQLite's own WAL checkpoint off, so its
// commit can't run one; the caller checkpoints in a turn of its own.
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
