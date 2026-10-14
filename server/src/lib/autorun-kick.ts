// Clean and formula columns' auto-runs follow their inputs (services/
// derived-follow.ts): a write that queues rows for one lets it know at once,
// so the column follows within a moment rather than at the next sweep. The
// hook is set in the API process only: a run worker's writes (another
// thread) wait for the sweep.
let hook: ((entryId: string) => void) | null = null;

// The auto-run kinds that follow their inputs: every written row is queued,
// whatever the column's cell holds, and every new row is worked out. (SQL
// spells the list out: kind IN ('clean', 'formula').)
export const isFollowKind = (kind: string): boolean => kind === 'clean' || kind === 'formula';

export function onFollowQueued(fn: (entryId: string) => void): void {
  hook = fn;
}

export function followQueued(entryId: string): void {
  hook?.(entryId);
}
