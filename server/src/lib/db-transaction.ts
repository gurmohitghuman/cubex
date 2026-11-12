// A transaction that only reads, on this thread's connection (lib/db.ts): several reads from one snapshot.
// DEFERRED, so it takes no write lock: it never waits for a writer and no writer waits for it. Never write in
// one. Every transaction that writes is begun with `.immediate()` instead (`db.transaction(fn).immediate()`):
// other connections write to the same file (run workers, the lookup worker, the WAL checkpoint worker), and
// busy_timeout (5 s) covers only a transaction's FIRST lock. A deferred transaction takes the write lock at its
// first write; when it has read before that, SQLite refuses that write at once with "database is locked"
// (SQLITE_BUSY_SNAPSHOT if another connection committed since the read, SQLITE_BUSY while one holds the write
// lock), and nothing waits. An immediate one takes the write lock at BEGIN, waiting for it like any first lock.
// tests/unit/db-transactions-guard.test.ts fails on a transaction begun any other way, and on a read transaction
// it doesn't list with why it only reads.
import type { Transaction } from 'better-sqlite3';
import { db } from './db';

// The driver's own bound for a transaction's function.
type Fn = (...args: any[]) => unknown;

// The transaction as a function, called with the arguments `fn` takes (nested in another transaction, it runs
// as a savepoint).
export function readTransaction<F extends Fn>(fn: F): Transaction<F>['deferred'] {
  return db.transaction(fn).deferred;
}
