// What the code under test does to SQLite while a test measures it, on the test's own connection: each
// transaction's time (a transform page is one) and the most WAL frames one added, each WAL checkpoint run on
// this connection with its time and frames copied, how many transactions wrote the main database file (in WAL
// mode a commit writes only the -wal file, so that is SQLite's own checkpoint running inside the commit), the
// most frames the WAL held, and the most frames not all copied back a transaction found in the WAL before adding
// its own (one finding them all copied starts the WAL over: none). A NOOP checkpoint (wal_checkpoint(NOOP): it
// only reads the WAL's size, copying nothing, lib/wal-checkpointer.ts) is counted apart, as a read.
// db.transaction, db.pragma, db.prepare and db.exec are wrapped on the connection: the app calls them at run
// time, so its code is unchanged. Each transaction is also kept as a record: when it began (performance.now(),
// before its BEGIN, so a wait for the lock counts in it), its time, the WAL's frames (and of
// them copied) before and after it, whether it started the WAL over (the WAL header's checkpoint count or salt
// changed, or its frames fell: SQLite then syncs the new header to disk inside that commit, on this connection's
// thread), and whether a checkpoint asked of the worker was still unanswered when it began (`checkpointing`).
import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
import type Database from 'better-sqlite3'

export interface WriteProbeStats {
  transactions: number; longestTransactionMs: number; transactionsWritingMainFile: number
  mostTransactionFrames: number; checkpoints: number; longestCheckpointMs: number; mostCheckpointFrames: number
  walReads: number; mostWalFrames: number; mostWalFramesBeforeWrite: number
}

export interface TransactionRecord {
  n: number; at: number; ms: number; before: WalNow; after: WalNow; startedOver: boolean; checkpointing: boolean
}
interface WalNow { log: number; checkpointed: number }
// One short line: `#n 12.3 ms, WAL 1500/1500 -> 53/0, started over, checkpoint asked`.
export const transactionLine = (r: TransactionRecord) => `#${r.n} ${r.ms.toFixed(1)} ms, WAL `
  + `${r.before.log}/${r.before.checkpointed} -> ${r.after.log}/${r.after.checkpointed}`
  + `${r.startedOver ? ', started over' : ''}${r.checkpointing ? ', checkpoint asked' : ''}`

const NOOP = /^\s*(PRAGMA\s+)?wal_checkpoint\s*\(\s*noop\s*\)\s*;?\s*$/i

// `checkpointing`: whether a checkpoint asked of the worker has yet to answer (lib/wal-checkpointer.ts).
export function sqliteWriteProbe(db: Database.Database, dbPath: string, checkpointing: () => boolean = () => false) {
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
  const wal = (): WalNow => (pragma('wal_checkpoint(NOOP)') as WalNow[])[0] ?? { log: 0, checkpointed: 0 }
  // The WAL header's checkpoint count and salts (bytes 12 to 24), which SQLite changes when it starts the WAL over;
  // null while the file has no header. One handle for the probe's life (the -wal file carries no lock).
  let walFd: number | undefined
  const header = Buffer.alloc(12)
  const walHeader = (): string | null => {
    try {
      walFd ??= fs.openSync(`${dbPath}-wal`, 'r')
      return fs.readSync(walFd, header, 0, 12, 12) === 12 ? header.toString('hex') : null
    } catch { return null }
  }
  let records: TransactionRecord[] = []
  const timed = (f: (...a: unknown[]) => unknown) => (...a: unknown[]) => {
    const before = mtime()
    const w0 = wal()
    const h0 = walHeader()
    const asked = checkpointing()
    const t0 = performance.now()
    try { return f(...a) } finally {
      const ms = performance.now() - t0
      s.transactions++
      s.longestTransactionMs = Math.max(s.longestTransactionMs, ms)
      if (mtime() !== before) s.transactionsWritingMainFile++
      const w1 = wal()
      const h1 = walHeader()
      const log1 = w1.log
      records.push({ n: s.transactions, at: t0, ms, before: w0, after: w1, checkpointing: asked,
        startedOver: (h1 !== null && h1 !== h0) || log1 < w0.log })
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
    // A new window: the WAL emptied (not counted), the numbers zeroed. TRUNCATE leaves the -wal file empty, so the
    // next commit writes a header (and syncs it): one write here, not counted, rewriting user_version with its own
    // value, begins the WAL again, as it always is once a server has written.
    reset() {
      pragma('wal_checkpoint(TRUNCATE)')
      pragma(`user_version = ${Number(pragma('user_version', { simple: true }))}`)
      s = zero()
      records = []
    },
    read(): WriteProbeStats { return { ...s } },
    // Every transaction since the last reset, in order.
    records(): TransactionRecord[] { return [...records] },
    // The `count` slowest, slowest first.
    slowest(count: number): TransactionRecord[] { return [...records].sort((x, y) => y.ms - x.ms).slice(0, count) },
  }
}
