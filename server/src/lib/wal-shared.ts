// Memory the API thread and the WAL checkpoint worker share (lib/wal-checkpointer.ts hands it to the worker in
// workerData), as Int32 slots. TURN says whose turn it is to write: a transform_column write on the API thread
// (lib/wal-turn.ts) or the worker's write that starts the WAL over (wal-checkpoint-worker.ts). Each side takes it
// from FREE with Atomics.compareExchange before its transaction, never waiting for it, and gives it back once that
// transaction ended. The other slots are for tests and stay 0 otherwise.
export const TURN = 0;
export const FREE = 0;
export const PAGE = 1;
export const WORKER = 2;
// Tests only: the worker holds its start-over write this many ms once it took the write lock (HELD is 1
// meanwhile; a notify on HOLD_MS ends it early), or makes it with its connection refusing writes (READ_ONLY 1).
export const HOLD_MS = 1;
export const HELD = 2;
export const READ_ONLY = 3;

export const walShared = new Int32Array(new SharedArrayBuffer(4 * 4));

// Tests only: the hold, whether the worker is in it now, and its end.
export function holdStartOverForTests(ms: number): void { Atomics.store(walShared, HOLD_MS, ms); }
export const startOverHeldForTests = (): boolean => Atomics.load(walShared, HELD) === 1;
export function endStartOverHoldForTests(): void {
  Atomics.store(walShared, HOLD_MS, 0);
  Atomics.notify(walShared, HOLD_MS);
}
// Tests only: the worker's connection refuses its start-over write (PRAGMA query_only), as a read-only one would.
export function startOverReadOnlyForTests(on: boolean): void { Atomics.store(walShared, READ_ONLY, on ? 1 : 0); }
