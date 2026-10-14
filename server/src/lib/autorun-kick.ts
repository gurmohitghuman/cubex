// A write that queues rows for a clean data column's auto-run lets it know at
// once (services/clean-follow.ts), so the column follows its source within a
// moment rather than at the next sweep. The hook is set in the API process
// only: a run worker's writes (another thread) wait for the sweep.
let hook: ((entryId: string) => void) | null = null;

export function onCleanQueued(fn: (entryId: string) => void): void {
  hook = fn;
}

export function cleanQueued(entryId: string): void {
  hook?.(entryId);
}
