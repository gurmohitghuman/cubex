// What the code under test does to SQLite while a test measures it, on the test's own connection: each
// transaction's time (a transform page is one) and the most WAL frames one added, each WAL checkpoint run on
// this connection with its time and frames copied, how many transactions wrote the main database file (in WAL
// mode a commit writes only the -wal file, so that is SQLite's own checkpoint running inside the commit), the
// most frames the WAL held, and the most frames not all copied back a transaction found in the WAL before adding
// its own (one finding them all copied starts the WAL over: none). A NOOP checkpoint (wal_checkpoint(NOOP): it
// only reads the WAL's size, copying nothing, lib/wal-checkpointer.ts) is counted apart, as a read.
// db.transaction, db.pragma, db.prepare and db.exec are wrapped on the connection: the app calls them at run
// time, so its code is unchanged.
import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
import type Database from 'better-sqlite3'

export interface WriteProbeStats {
  transactions: number; longestTransactionMs: number; transactionsWritingMainFile: number
  mostTransactionFrames: number; checkpoints: number; longestCheckpointMs: number; mostCheckpointFrames: number
  walReads: number; mostWalFrames: number; mostWalFramesBeforeWrite: number
}

const NOOP = /^\s*(PRAGMA\s+)?wal_checkpoint\s*\(\s*noop\s*\)\s*;?\s*$/i

export function sqliteWriteProbe(db: Database.Database, dbPath: string) {
  const pageSize = db.pragma('page_size', { simple: true }) as number
  const mtime = () => fs.statSync(dbPath, { bigint: true }).mtimeNs
  // Frames in the -wal file: its 32-byte header, then each frame a 24-byte header and a page.
  const walFrames = () => {
    try { return Math.max(0, Math.round((fs.statSync(`${dbPath}-wal`).size - 32) / (pageSize + 24))) }
    catch { return 0 }
  }
  const zero = (): WriteProbeStats => ({ transactions: 0, longestTransactionMs: 0, transactionsWritingMainFile: 0,
    mostTransactionFrames: 0, checkpoints: 0, longestCheckpointMs: 0, mostCheckpointFrames: 0, walReads: 0,
    mostWalFrames: 0, mostWalFramesBeforeWrite: 0 })
  let s = zero()
  const pragma = db.pragma.bind(db)
  // Frames in the WAL now, and of them copied back (SQLite starts it over from its first frame once all were).
  const wal = () => (pragma('wal_checkpoint(NOOP)') as Array<{ log: number; checkpointed: number }>)[0]
    ?? { log: 0, checkpointed: 0 }
  const timed = (f: (...a: unknown[]) => unknown) => (...a: unknown[]) => {
    const before = mtime()
    const w0 = wal()
    const t0 = performance.now()
    try { return f(...a) } finally {
      s.transactions++
      s.longestTransactionMs = Math.max(s.longestTransactionMs, performance.now() - t0)
      if (mtime() !== before) s.transactionsWritingMainFile++
      const log1 = wal().log
      s.mostTransactionFrames = Math.max(s.mostTransactionFrames, log1 >= w0.log ? log1 - w0.log : log1)
      s.mostWalFrames = Math.max(s.mostWalFrames, walFrames())
      if (log1 > w0.log && w0.checkpointed < w0.log) {
        s.mostWalFramesBeforeWrite = Math.max(s.mostWalFramesBeforeWrite, w0.log)
      }
    }
  }
  const transaction = db.transaction.bind(db)
  db.transaction = ((fn: (...a: unknown[]) => unknown) => {
    const t = transaction(fn)
    const w = timed(t) as unknown as Record<string, unknown>
    for (const k of ['default', 'deferred', 'immediate', 'exclusive'] as const) w[k] = timed(t[k])
    return w
  }) as unknown as typeof db.transaction
  db.pragma = ((src: string, opts?: Database.PragmaOptions) => {
    if (!/wal_checkpoint/i.test(src)) return pragma(src, opts)
    if (NOOP.test(src)) { s.walReads++; return pragma(src, opts) }
    const t0 = performance.now()
    const out = pragma(src, opts) as Array<{ log: number }>
    s.checkpoints++
    s.longestCheckpointMs = Math.max(s.longestCheckpointMs, performance.now() - t0)
    s.mostCheckpointFrames = Math.max(s.mostCheckpointFrames, out?.[0]?.log ?? 0)
    return out
  }) as typeof db.pragma
  // A checkpoint sent as SQL counts too.
  const sql = (src: string) => { if (/wal_checkpoint/i.test(src) && !NOOP.test(src)) s.checkpoints++ }
  const prepare = db.prepare.bind(db)
  db.prepare = ((src: string) => { sql(src); return prepare(src) }) as typeof db.prepare
  const exec = db.exec.bind(db)
  db.exec = ((src: string) => { sql(src); return exec(src) }) as typeof db.exec
  return {
    // The frames at which SQLite runs its own checkpoint inside a commit (wal_autocheckpoint).
    autoCheckpointFrames: db.pragma('wal_autocheckpoint', { simple: true }) as number,
    // A new window: the WAL emptied (not counted), the numbers zeroed.
    reset() { pragma('wal_checkpoint(TRUNCATE)'); s = zero() },
    read(): WriteProbeStats { return { ...s } },
  }
}
