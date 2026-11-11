// What the code under test does to SQLite while a test measures it, on the test's own connection: each
// transaction's time (a transform page is one), each WAL checkpoint's time and frames copied, how many
// transactions wrote the main database file (in WAL mode a commit writes only the -wal file, so that is SQLite's
// own checkpoint running inside the commit), and the most frames the WAL held. db.transaction and db.pragma are
// wrapped on the connection: the app calls them at run time, so its code is unchanged.
import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
import type Database from 'better-sqlite3'

export interface WriteProbeStats {
  transactions: number; longestTransactionMs: number; transactionsWritingMainFile: number
  checkpoints: number; longestCheckpointMs: number; mostCheckpointFrames: number; mostWalFrames: number
}

export function sqliteWriteProbe(db: Database.Database, dbPath: string) {
  const pageSize = db.pragma('page_size', { simple: true }) as number
  const mtime = () => fs.statSync(dbPath, { bigint: true }).mtimeNs
  // Frames in the -wal file: its 32-byte header, then each frame a 24-byte header and a page.
  const walFrames = () => {
    try { return Math.max(0, Math.round((fs.statSync(`${dbPath}-wal`).size - 32) / (pageSize + 24))) }
    catch { return 0 }
  }
  const zero = (): WriteProbeStats => ({ transactions: 0, longestTransactionMs: 0, transactionsWritingMainFile: 0,
    checkpoints: 0, longestCheckpointMs: 0, mostCheckpointFrames: 0, mostWalFrames: 0 })
  let s = zero()
  const timed = (f: (...a: unknown[]) => unknown) => (...a: unknown[]) => {
    const before = mtime()
    const t0 = performance.now()
    try { return f(...a) } finally {
      s.transactions++
      s.longestTransactionMs = Math.max(s.longestTransactionMs, performance.now() - t0)
      if (mtime() !== before) s.transactionsWritingMainFile++
      s.mostWalFrames = Math.max(s.mostWalFrames, walFrames())
    }
  }
  const transaction = db.transaction.bind(db)
  db.transaction = ((fn: (...a: unknown[]) => unknown) => {
    const t = transaction(fn)
    const w = timed(t) as unknown as Record<string, unknown>
    for (const k of ['default', 'deferred', 'immediate', 'exclusive'] as const) w[k] = timed(t[k])
    return w
  }) as unknown as typeof db.transaction
  const pragma = db.pragma.bind(db)
  db.pragma = ((src: string, opts?: Database.PragmaOptions) => {
    if (!src.startsWith('wal_checkpoint')) return pragma(src, opts)
    const t0 = performance.now()
    const out = pragma(src, opts) as Array<{ log: number }>
    s.checkpoints++
    s.longestCheckpointMs = Math.max(s.longestCheckpointMs, performance.now() - t0)
    s.mostCheckpointFrames = Math.max(s.mostCheckpointFrames, out?.[0]?.log ?? 0)
    return out
  }) as typeof db.pragma
  return {
    // The frames at which SQLite runs its own checkpoint inside a commit (wal_autocheckpoint).
    autoCheckpointFrames: db.pragma('wal_autocheckpoint', { simple: true }) as number,
    // A new window: the WAL emptied (not counted), the numbers zeroed.
    reset() { pragma('wal_checkpoint(TRUNCATE)'); s = zero() },
    read(): WriteProbeStats { return { ...s } },
  }
}
