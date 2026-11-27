// Writes tried with SQLite's busy wait off, counted: lib/write-when-free.ts and services/column-transform-end.ts
// (settle) set busy_timeout 0 around each try, so a write lock held by another connection refuses the try at once
// and it is tried again on a timer, never waiting for the lock on the server's thread. A test that holds the lock
// counts these tries while it does: the write it watches was tried (and refused) without waiting, and once the lock
// is let go a later try writes it. A write that waited for the lock would set no such pragma, or be made once, when
// the lock was let go. Not a test itself (no .test.ts): it wraps the connection's pragma for the test's life.
import type BetterSqlite from 'better-sqlite3'

const BUSY_OFF = /^\s*busy_timeout\s*=\s*0\s*$/i

export function busyFreeTries(db: BetterSqlite.Database): { count: () => number } {
  let tries = 0
  const pragma = db.pragma.bind(db)
  db.pragma = ((source: string, options?: BetterSqlite.PragmaOptions) => {
    if (BUSY_OFF.test(source)) tries++
    return pragma(source, options)
  }) as typeof db.pragma
  return { count: () => tries }
}
