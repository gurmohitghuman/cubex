// A transform_column call's writes on the API thread (its pages, services/column-transform-pages.ts, and the few
// writes around them, column-transform.ts and column-transform-end.ts), each taken in turn with the checkpoint
// worker's write that starts the WAL over (wal-checkpoint-worker.ts): so none waits for the write lock while the
// worker syncs the WAL's new header, and none starts the WAL over itself, which syncs that header inside its own
// commit, on the event loop. Taking turns never waits: each side takes TURN (lib/wal-shared.ts) with
// Atomics.compareExchange before its transaction and gives it back once that ended. A write that finds the worker's
// turn awaits that checkpoint's answer (the event loop free), then tries again; a worker that finds a write's
// skips its start-over, and that write asks for another checkpoint.
// In its turn, before its transaction, a write reads the WAL (NOOP, on this connection): every frame copied (an
// empty WAL too: its first write writes and syncs the header), it doesn't write; it asks the worker for a
// checkpoint, which starts the WAL over, awaits the answer, and checks again. A checkpoint can still copy the last
// frames between that read and the transaction's BEGIN, and a transaction that began with every frame copied starts
// the WAL over at its commit. So the transaction's first statement (walTurnCheck) reads the WAL again, on a second
// connection (this one can't while in a transaction): holding the write lock, nothing adds frames and copied ones
// only grow, so a frame still uncopied then means the commit adds to the WAL. Every frame copied: the transaction
// ends unwritten and asks too. Past `until` a page asks no more and answers 'late', writing nothing; a write that
// must be made (`anyway`) still takes its turn, then writes, and may start the WAL over here.
// Other writers (autosave, webhooks, run workers) don't take turns: one that comes while the worker starts the WAL
// over waits for the lock about one header sync, as long as starting it over itself would take. If the worker
// can't run, can't write, or failed, the write goes on and starts the WAL over here (lib/wal-checkpointer.ts).
import Database from 'better-sqlite3';
import { DB_PATH } from './db-path';
import { WAL_PAUSE_RETRY_MS } from './constants';
import { FREE, PAGE, TURN, walShared } from './wal-shared';
import {
  byDeadline, checkpointAnswer, checkpointInBackground, checkpointsOnWorker, walState,
  type Checkpointed, type WalState,
} from './wal-checkpointer';

const STARTS_OVER = new Error('This write would start the WAL over on the API thread.');
const zero = () => ({ writes: 0, turnWaits: 0, asks: 0, caughtInside: 0 });
let stats = zero();
let checking = false;
let reader: { noop: Database.Statement } | undefined;
let beforeWrite: (() => void) | null = null;

// The WAL as a second connection reads it: one that never reads a table, so it holds no snapshot and never keeps
// SQLite from starting the WAL over. query_only: it never writes either. If it can't be read, null (logged once).
let unread = false;
function walElsewhere(): WalState | null {
  try {
    if (!reader) {
      const conn = new Database(DB_PATH, { fileMustExist: true });
      conn.pragma('query_only = ON');
      reader = { noop: conn.prepare('PRAGMA wal_checkpoint(NOOP)') };
    }
    const r = reader.noop.get() as { log: number; checkpointed: number } | undefined;
    return r && r.log >= 0 && r.checkpointed >= 0 ? { log: r.log, checkpointed: r.checkpointed } : null;
  } catch (err) {
    if (!unread) console.error('Reading the WAL\'s size on a second connection failed:', err);
    unread = true;
    return null;
  }
}
// The next write would start the WAL over (or write its first header). null (the size unread): it goes on.
const allCopied = (s: WalState | null): boolean => s !== null && s.checkpointed === s.log;

// The first statement of a transaction written in turn: throws, so it ends unwritten, when it began with every
// frame of the WAL copied. Outside inWalTurn (or once asking is over) it does nothing.
export function walTurnCheck(): void {
  if (checking && allCopied(walElsewhere())) { stats.caughtInside++; throw STARTS_OVER; }
}

// Asking again is worth it after a checkpoint that couldn't start the WAL over for a moment only: a write held
// the turn or the write lock, another checkpoint ran, or the frames were copied after it looked.
const worthAsking = (last: Checkpointed | null | undefined): boolean => last === undefined
  || (last !== null && last.startOver !== 'read-only' && last.startOver !== 'failed');
const wait = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

// `write` makes one transaction, its first statement walTurnCheck() when it has more than one, and answers what
// it does.
export async function inWalTurn<T>(write: () => T, until: number, anyway = false): Promise<T | 'late'> {
  let last: Checkpointed | null | undefined;
  for (;;) {
    const late = Date.now() >= until;
    if (late && !anyway) return 'late';
    if (Atomics.compareExchange(walShared, TURN, FREE, PAGE) !== FREE) {
      // The worker is starting the WAL over: its answer, then again.
      stats.turnWaits++;
      const answer: Promise<unknown> = checkpointAnswer() ?? wait(WAL_PAUSE_RETRY_MS);
      await (late ? answer : byDeadline(answer, until));
      continue;
    }
    const ask = !late && checkpointsOnWorker() && worthAsking(last);
    try {
      if (!(ask && allCopied(walState()))) {
        beforeWrite?.();
        checking = ask;
        const out = write();
        stats.writes++;
        return out;
      }
    } catch (err) {
      if (err !== STARTS_OVER) throw err;
    } finally {
      checking = false;
      Atomics.compareExchange(walShared, TURN, PAGE, FREE);
    }
    stats.asks++;
    // Asked again: a moment later, so a turn or lock held elsewhere can end.
    if (last !== undefined && (await byDeadline(wait(WAL_PAUSE_RETRY_MS), until)) === 'late') continue;
    const r = await byDeadline(checkpointInBackground(), until);
    if (r !== 'late') last = r;
  }
}

// Writes made in turn, waits for the worker's turn, asks for a checkpoint to start the WAL over (of them, those a
// transaction's first statement made), since the last read.
export function takeWalTurnStats(): ReturnType<typeof zero> {
  const s = stats;
  stats = zero();
  return s;
}
// Tests only: run between a write's read of the WAL and its transaction.
export function setBeforeTurnWriteForTests(fn: (() => void) | null): void { beforeWrite = fn; }
// At shutdown, and in tests: the second connection closes (a later check opens it again).
export function closeWalTurnReader(): void {
  const r = reader;
  reader = undefined;
  if (r) r.noop.database.close();
}
