// The loop watch on Linux (loop-watch-waits.ts): where this thread waited, from the kernel. A plain commit writing its
// frames into WAL pages no longer in memory reads each back from disk first (a frame is 4,120 bytes, so its writes
// cover pages in part): that time is let off, printed with its wait points. With the wait point unreadable, nothing
// is let off for the disk (it fails closed). A commit waiting on a futex (Atomics.wait, as for a worker) is not let
// off; a write waiting for SQLite's write lock is loop-watch.test.ts's case, run there on Linux too. With more busy
// processes than CPUs, a transaction busy on the CPU is let off only its time waiting for a CPU, never its CPU time.
// Linux only: elsewhere the disk thread watches (loop-watch.test.ts).
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import dbMod from '../../server/src/lib/db'
import { heldText, loopWatch, type LoopWatched, type WatchOptions } from './loop-watch'
import { DISK_WAITS } from './loop-watch-waits'
import { sqliteWriteProbe, transactionLine } from './sqlite-write-probe'
const { db } = dbMod as typeof import('../../server/src/lib/db')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
if (process.platform !== 'linux') {
  console.log('skip: Linux only (elsewhere the disk thread watches, loop-watch.test.ts)')
  process.exit(0)
}
let failures = 0
async function ok(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
const BOUND_MS = 100
const HOLD_MS = 250
const probe = sqliteWriteProbe(db, process.env.DB_PATH)
db.exec('CREATE TABLE loop_watch (v INTEGER); CREATE TABLE loop_watch_wal (b BLOB)')
const add = db.prepare('INSERT INTO loop_watch (v) VALUES (?)')
const blob = db.prepare('INSERT INTO loop_watch_wal (b) VALUES (randomblob(3000))')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const blobs = (n: number) => db.transaction(() => { for (let i = 0; i < n; i++) blob.run() }).immediate()

// `hold` watched; `before` runs first, after the probe's reset (which empties the WAL).
async function watched(label: string, hold: () => Promise<void> | void, opts: WatchOptions = {}, before = () => {}) {
  probe.reset()
  before()
  const watch = loopWatch(probe.records, opts)
  await watch.ready
  await sleep(20)
  try { await hold() } finally { await sleep(20) }
  const w = watch()
  console.log(`      ${label}: ${heldText(w)}; ${w.inside.map(transactionLine).join(' | ') || 'no transaction'}`)
  await Promise.race([w.ended, sleep(5_000)])
  return w
}
const fromDisk = (w: LoopWatched) => w.letOffTotal.from.filter(([what]) => DISK_WAITS.includes(what))
// CPU time is never let off.
const cpuCounts = (w: LoopWatched) => assert.ok(w.ownMs + 1 >= w.own.cpuMs, heldText(w))

// Bytes this thread read from the disk so far.
const readBytes = () => Number(/read_bytes:\s*(\d+)/.exec(fs.readFileSync('/proc/thread-self/io', 'utf8'))![1])
// A WAL of about 3,000 frames copied back, started over by a small commit (which syncs, so it is never let off),
// then its pages dropped from memory (dd's nocache: posix_fadvise DONTNEED). A commit of about 1,500 frames, under
// the auto-checkpoint, then writes into pages it must read back first. The bytes it read are returned.
async function evictedCommit(label: string, opts: WatchOptions = {}) {
  let read = 0
  const w = await watched(label, () => {
    const r0 = readBytes()
    blobs(1_500)
    read = readBytes() - r0
  }, opts, () => {
    blobs(3_000)
    db.pragma('wal_checkpoint(RESTART)')
    add.run(1)
    execFileSync('dd', [`if=${process.env.DB_PATH}-wal`, 'iflag=nocache', 'count=0', 'status=none'])
  })
  console.log(`      the commit read ${(read / 1024).toFixed(0)} KB from the disk`)
  const [r] = w.inside
  assert.ok(read >= 1 << 20 && r && !r.startedOver && !r.ownCheckpoint, `read ${read} bytes; ${w.inside
    .map(transactionLine).join(' | ')}`)
  return w
}

await ok('a plain commit writing into WAL pages no longer in memory: its disk waits let off, printed with their wait '
  + 'points', async () => {
  const w = await evictedCommit('evicted WAL pages')
  assert.ok(fromDisk(w).length > 0, heldText(w))
  assert.match(heldText(w), new RegExp(`ms let off: [^)]*(${DISK_WAITS.join('|')}) \\d+ ms`))
  cpuCounts(w)
})

await ok('the same with the wait point unreadable: nothing let off for the disk', async () => {
  const w = await evictedCommit('evicted WAL pages, wchan unreadable', { wchan: '/proc/self/task/0/no-wchan' })
  assert.deepEqual(fromDisk(w), [], heldText(w))
})

await ok(`a plain commit waiting ${HOLD_MS} ms on a futex (Atomics.wait, as for a worker): not let off`, async () => {
  const w = await watched('a futex in a commit', () => db.transaction(() => {
    add.run(2)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, HOLD_MS)
  }).immediate())
  assert.ok(w.ownMs >= HOLD_MS - 50, heldText(w))
  assert.deepEqual(fromDisk(w), [], heldText(w))
})

await ok('more busy processes than CPUs: a transaction busy on the CPU is let off only its time waiting for a CPU',
  async () => {
    const hogs: ChildProcess[] = []
    try {
      for (let i = 0; i < os.availableParallelism() + 2; i++) {
        hogs.push(spawn(process.execPath, ['-e', 'for (;;) {}'], { stdio: 'ignore' }))
      }
      await sleep(200)
      const w = await watched('busy, the CPUs shared', () => db.transaction(() => {
        add.run(3)
        for (const end = performance.now() + 2 * HOLD_MS; performance.now() < end;) { /* busy */ }
      }).immediate())
      const own = w.own.from ?? []
      assert.ok(w.own.letOffMs > 0 && own.every(([what]) => what === 'waiting for a CPU'), heldText(w))
      cpuCounts(w)
      assert.ok(w.ownMs >= BOUND_MS, heldText(w))
    } finally {
      for (const h of hogs) h.kill('SIGKILL')
    }
  })

if (failures > 0) { console.error(`${failures} loop-watch-waits assertion(s) failed`); process.exit(1) }
console.log('All loop-watch-waits assertions passed.')
process.exit(0)
