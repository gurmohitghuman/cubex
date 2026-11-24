// What the code under test does to SQLite while a test measures it, on the test's own connection: each
// transaction's time (a transform page is one) and the most WAL frames one added, each WAL checkpoint run on
// this connection with its time and frames copied, how many transactions wrote the main database file (in WAL
// mode a commit writes only the -wal file, so that is SQLite's own checkpoint running inside the commit), the
// most frames the WAL held, and the most frames not all copied back a transaction found in the WAL before adding
// its own (one finding them all copied starts the WAL over: none). A NOOP checkpoint (wal_checkpoint(NOOP): it
// only reads the WAL's size, copying nothing, lib/wal-checkpointer.ts) is counted apart, as a read.
// db.transaction, db.pragma, db.prepare and db.exec are wrapped on the connection: the app calls them at run time, so
// its code is unchanged. Each transaction is also kept as a record: when it began (performance.now(), before its BEGIN,
// so a wait for the lock counts in it), its time and its thread's CPU time in it (process.threadCpuUsage: a time well
// over its CPU time waited, on the disk or for the process to run; on Windows CPU time is counted in clock ticks of
// about 16 ms), the WAL's frames (and of them copied) before and after it, whether it started the WAL over (the WAL
// header's checkpoint count or salt changed, or its frames fell: SQLite then syncs the new header to disk inside that
// commit, on this connection's thread), whether a checkpoint asked of the worker was still unanswered when it began
// (`checkpointing`), whether SQLite's own checkpoint ran inside its commit (`ownCheckpoint`: the commit left the
// WAL at or past wal_autocheckpoint with it on; with a worker copying the WAL back meanwhile, the main file's mtime
// can't tell), and whether it grew the -wal file (`grew`: on Windows such a commit can wait on the OS, which is why
// the server makes the file its full size at start, lib/wal-file.ts). The WAL's frames are SQLite's count, not the
// file's size: a file made its full size holds zeros past them.
// A transaction begun inside another (a savepoint) is part of that one, not a record of its own.
import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
import type Database from 'better-sqlite3'
import walFileMod from '../../server/src/lib/wal-file'
const { sizeWalFile, walFileSizing } = walFileMod as typeof import('../../server/src/lib/wal-file')

export interface WriteProbeStats {
  transactions: number; longestTransactionMs: number; transactionsWritingMainFile: number
  mostTransactionFrames: number; checkpoints: number; longestCheckpointMs: number; mostCheckpointFrames: number
  walReads: number; mostWalFrames: number; mostWalFramesBeforeWrite: number; ownCheckpoints: number
}

export interface TransactionRecord {
  n: number; at: number; ms: number; cpuMs: number; before: WalNow; after: WalNow; startedOver: boolean
  checkpointing: boolean; ownCheckpoint: boolean; grew: boolean
}
interface WalNow { log: number; checkpointed: number }
// One short line: `#n 12.3 ms (cpu 11.8 ms), WAL 1500/1500 -> 53/0, started over, checkpoint asked, grew the -wal`.
export const transactionLine = (r: TransactionRecord) => `#${r.n} ${r.ms.toFixed(1)} ms `
  + `(cpu ${r.cpuMs.toFixed(1)} ms), WAL ${r.before.log}/${r.before.checkpointed} -> `
  + `${r.after.log}/${r.after.checkpointed}${r.startedOver ? ', started over' : ''}`
  + `${r.checkpointing ? ', checkpoint asked' : ''}${r.grew ? ', grew the -wal' : ''}`

const NOOP = /^\s*(PRAGMA\s+)?wal_checkpoint\s*\(\s*noop\s*\)\s*;?\s*$/i

// `checkpointing`: whether a checkpoint asked of the worker has yet to answer (lib/wal-checkpointer.ts).
export function sqliteWriteProbe(db: Database.Database, dbPath: string, checkpointing: () => boolean = () => false) {
  const mtime = () => fs.statSync(dbPath, { bigint: true }).mtimeNs
  const walBytes = () => { try { return fs.statSync(`${dbPath}-wal`).size } catch { return 0 } }
  const zero = (): WriteProbeStats => ({ transactions: 0, longestTransactionMs: 0, transactionsWritingMainFile: 0,
    mostTransactionFrames: 0, checkpoints: 0, longestCheckpointMs: 0, mostCheckpointFrames: 0, walReads: 0,
    mostWalFrames: 0, mostWalFramesBeforeWrite: 0, ownCheckpoints: 0 })
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
    if (db.inTransaction) return f(...a)
    const before = mtime()
    const bytes0 = walBytes()
    const w0 = wal()
    const h0 = walHeader()
    const asked = checkpointing()
    const c0 = process.threadCpuUsage()
    const t0 = performance.now()
    try { return f(...a) } finally {
      const ms = performance.now() - t0
      const c = process.threadCpuUsage(c0)
      s.transactions++
      s.longestTransactionMs = Math.max(s.longestTransactionMs, ms)
      if (mtime() !== before) s.transactionsWritingMainFile++
      const w1 = wal()
      const h1 = walHeader()
      const log1 = w1.log
      const auto = pragma('wal_autocheckpoint', { simple: true }) as number
      const ownCheckpoint = auto > 0 && log1 >= auto
      if (ownCheckpoint) s.ownCheckpoints++
      records.push({ n: s.transactions, at: t0, ms, cpuMs: (c.user + c.system) / 1000, before: w0, after: w1,
        checkpointing: asked, ownCheckpoint, grew: walBytes() > bytes0,
        startedOver: (h1 !== null && h1 !== h0) || log1 < w0.log })
      s.mostTransactionFrames = Math.max(s.mostTransactionFrames, log1 >= w0.log ? log1 - w0.log : log1)
      s.mostWalFrames = Math.max(s.mostWalFrames, log1)
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
    // value, begins the WAL again, as it always is once a server has written. Then the file is made its full size
    // where a server does that at start (lib/wal-file.ts: Windows, or a test that switches it on).
    reset() {
      pragma('wal_checkpoint(TRUNCATE)')
      pragma(`user_version = ${Number(pragma('user_version', { simple: true }))}`)
      sizeWalFile(db, dbPath)
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

// Where a server makes the -wal file its full size at start (lib/wal-file.ts: Windows), a test that bounds the loop
// or a write does too, after its migrations, as index.ts does. Otherwise its commits grow the file, and on the
// Windows runner such a commit can wait on the OS off the CPU (token-last-used's write once held the loop 103 ms with
// no CPU time). True when the file is that size now.
export function sizeWalLikeAServer(db: Database.Database, dbPath: string): boolean {
  const r = sizeWalFile(db, dbPath)
  const sized = r.done === 'sized' || (r.done === 'skipped' && r.why === 'big enough')
  if (walFileSizing() && !sized) console.log(`      the -wal file wasn't made its full size (${JSON.stringify(r)})`)
  return sized
}

// Made its full size, no write may grow the -wal file. A window from now: its check answers the transactions of
// `records` begun in it that grew the file, or how much the file grew in it (a write outside a transaction, or on
// another connection); '' when none did, or when the file wasn't made its full size.
export function walGrowth(dbPath: string, sized: boolean): (records: TransactionRecord[]) => string {
  const bytes = () => { try { return fs.statSync(`${dbPath}-wal`).size } catch { return 0 } }
  const from = bytes(), t0 = performance.now()
  return records => {
    if (!sized) return ''
    const grew = records.filter(r => r.at >= t0 && r.grew).map(transactionLine)
    const now = bytes()
    return grew.length > 0 ? grew.join(' | ') : now > from ? `the -wal file grew from ${from} to ${now} bytes` : ''
  }
}
