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

// Let requests that queued up meanwhile run before the next slice.
export function yieldToRequests(): Promise<void> {
  return new Promise<void>(resolve => setImmediate(resolve));
}
