// Long jobs over a million rows run as many short slices: each call to `step`
// does a bounded amount of work (one short transaction, well under 100 ms) and
// returns true while there is more. Between slices the event loop serves other
// requests, so a sort or an import never freezes the server, and SQLite's write
// lock is released often enough for other writers (autosave, webhooks, run
// workers) to get in.
export async function runInSlices(step: () => boolean): Promise<void> {
  while (step()) await yieldToRequests();
}

// Let requests that queued up meanwhile run before the next slice.
export function yieldToRequests(): Promise<void> {
  return new Promise<void>(resolve => setImmediate(resolve));
}
