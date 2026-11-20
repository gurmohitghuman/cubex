// The loop watch's own check (loop-watch.ts): a hold of the event loop by this thread alone still counts in full
// against a bound while the idle thread runs on, whether the thread was busy on the CPU (a transaction working 250 ms)
// or waiting (a write waiting 250 ms for SQLite's write lock, held on another thread); a pause of the whole process
// (SIGSTOP, then SIGCONT 300 ms later; not on Windows, which has no such signal) is let off, and printed; after a
// longer pause, a busy transaction is still the hold named, with its transaction; the idle thread ends once the watch
// is read. The disk (loop-watch-disk.ts): a plain commit waiting off the CPU while the disk thread's writes are stuck
// is let off, and printed; a transaction busy on the CPU, or a wait outside any transaction, is not, the disk stuck
// or not; a commit that syncs is never let off, and a pause is not let off twice; the disk thread's file is beside
// the database and gone once the watch is read.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import dbMod from '../../server/src/lib/db'
import { heldText, idleThreadsRunning, loopWatch, type LoopWatched } from './loop-watch'
import { diskLetOff } from './loop-watch-disk'
import { sqliteWriteProbe, transactionLine } from './sqlite-write-probe'
const { db } = dbMod as typeof import('../../server/src/lib/db')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
let failures = 0
async function ok(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
const BOUND_MS = 100
const HOLD_MS = 250
const probe = sqliteWriteProbe(db, process.env.DB_PATH)
db.exec('CREATE TABLE loop_watch (v INTEGER)')
const add = db.prepare('INSERT INTO loop_watch (v) VALUES (?)')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// `hold` watched, the loop then left free a moment so the sampler sees the stretch end; printed. With `stuck`, the
// disk thread's writes are stuck that long from just before the hold.
async function watched(label: string, hold: () => Promise<void> | void, stuck = 0): Promise<LoopWatched> {
  probe.reset()
  const watch = loopWatch(probe.records)
  await watch.ready
  await sleep(20)
  if (stuck > 0) {
    watch.stallDisk(stuck)
    await sleep(15)
  }
  try { await hold() } finally { await sleep(20) }
  const w = watch()
  console.log(`      ${label}: ${heldText(w)}; ${w.inside.map(transactionLine).join(' | ') || 'no transaction'}`)
  await Promise.race([w.ended, sleep(5_000)])
  return w
}
const held = (w: LoopWatched) => assert.ok(w.ownMs >= BOUND_MS,
  `held ${w.ownMs.toFixed(0)} ms by this thread alone (the idle thread late ${w.idleMs.toFixed(0)} ms): let off`)
const busy = () => db.transaction(() => {
  add.run(1)
  for (const end = performance.now() + HOLD_MS; performance.now() < end;) { /* busy */ }
}).immediate()
// The whole process stopped `ms` (SIGSTOP, then SIGCONT).
const pause = (ms: number) => new Promise<void>((res, rej) => {
  spawn('sh', ['-c', `kill -STOP ${process.pid}; sleep ${ms / 1000}; kill -CONT ${process.pid}`], { stdio: 'ignore' })
    .once('exit', code => (code === 0 ? res() : rej(new Error(`the pause exited ${code}`))))
})
const busyIn = (w: LoopWatched) => {
  const [r] = w.inside
  assert.ok(r && r.ms >= HOLD_MS && r.cpuMs >= 0.6 * r.ms, `the transaction: ${r ? transactionLine(r) : 'none'}`)
}

await ok(`a transaction busy on the CPU ${HOLD_MS} ms: held by this thread alone, past the bound`, async () => {
  const w = await watched('busy', busy)
  held(w)
  busyIn(w)
})

// The lock held on another thread, by its own connection: this thread waits in SQLite's busy handler (busy_timeout,
// lib/db.ts), off the CPU, as it would for a slow disk.
const LOCK_HOLDER = `
const { workerData: { file, path, holdMs }, parentPort } = require('node:worker_threads')
const Database = require(file)
const conn = new Database(path)
conn.exec('BEGIN IMMEDIATE')
conn.prepare('INSERT INTO loop_watch (v) VALUES (2)').run()
parentPort.postMessage('held')
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs)
conn.exec('COMMIT')
conn.close()
`
await ok(`a write waiting ${HOLD_MS} ms for the write lock: held by this thread alone, past the bound`, async () => {
  const file = createRequire(import.meta.url).resolve('better-sqlite3')
  const workerData = { file, path: process.env.DB_PATH, holdMs: HOLD_MS }
  let gone: Promise<unknown> = Promise.resolve()
  try {
    const w = await watched('waiting', async () => {
      const holder = new Worker(LOCK_HOLDER, { eval: true, workerData })
      gone = new Promise(r => holder.once('exit', r))
      await new Promise<void>((res, rej) => { holder.once('message', () => res()); holder.once('error', rej) })
      db.transaction(() => { add.run(3) }).immediate()
    })
    held(w)
    const [r] = w.inside
    assert.ok(r && r.ms >= HOLD_MS - 50 && r.cpuMs < 0.5 * r.ms, `the transaction: ${r ? transactionLine(r) : 'none'}`)
  } finally { await gone }
})

await ok('the whole process paused 300 ms: let off, and printed', async () => {
  if (process.platform === 'win32') {
    console.log('      not on Windows: it has no signal that pauses a process')
    return
  }
  const w = await watched('paused', () => pause(300))
  assert.ok(w.longest.ms >= 250, `the loop held only ${w.longest.ms.toFixed(0)} ms`)
  assert.ok(w.ownMs < BOUND_MS && w.idleMs >= w.longest.ms - BOUND_MS,
    `held ${w.ownMs.toFixed(0)} ms by this thread alone (the idle thread late ${w.idleMs.toFixed(0)} ms)`)
})

await ok(`paused 400 ms, then a transaction busy ${HOLD_MS} ms: that transaction named, past the bound`, async () => {
  if (process.platform === 'win32') {
    console.log('      not on Windows: it has no signal that pauses a process')
    return
  }
  const w = await watched('paused, then busy', async () => { await pause(400); await sleep(20); busy() })
  assert.ok(w.longest.ms >= 350 && w.ownStretch.at > w.longest.at, `the longest stretch ${w.longest.ms.toFixed(0)} `
    + `ms at ${w.longest.at.toFixed(0)}, the one held alone at ${w.ownStretch.at.toFixed(0)}`)
  held(w)
  busyIn(w)
})

const wait = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const STUCK_MS = HOLD_MS + 150
await ok(`a plain commit waiting ${HOLD_MS} ms off the CPU while the disk is stuck: let off, and printed`, async () => {
  const w = await watched('a commit, the disk stuck', () => db.transaction(() => { add.run(4); wait(HOLD_MS) })
    .immediate(), STUCK_MS)
  assert.ok(w.ownMs < BOUND_MS, heldText(w))
  assert.ok(w.letOffs.some(o => o.letOffMs >= HOLD_MS - 60), heldText(w))
  assert.match(heldText(w), /let off for the disk: \d+ ms \(CPU \d+ ms, the disk stuck \d+ ms, \d+ ms let off\)/)
})

await ok('a transaction busy on the CPU, the disk stuck: held by this thread alone, past the bound', async () => {
  held(await watched('busy, the disk stuck', busy, STUCK_MS))
})

await ok('a wait outside any transaction (for a worker), the disk stuck: held, past the bound', async () => {
  const w = await watched('a wait, the disk stuck', () => { wait(HOLD_MS) }, STUCK_MS)
  held(w)
  assert.equal(w.inside.length, 0)
})

await ok('a commit that syncs is never let off; a pause is not let off twice', () => {
  const r = { n: 1, at: 0, ms: 300, cpuMs: 10, before: { log: 0, checkpointed: 0 }, after: { log: 1, checkpointed: 0 },
    startedOver: false, checkpointing: false, ownCheckpoint: false }
  const stretch = { at: 0, ms: 300, cpuMs: 10 }
  const stuck = [{ from: 0, to: 300 }]
  assert.equal(diskLetOff(stretch, [], stuck, [r]).letOffMs, 290)
  for (const flag of ['startedOver', 'checkpointing', 'ownCheckpoint']) {
    assert.equal(diskLetOff(stretch, [], stuck, [{ ...r, [flag]: true }]).letOffMs, 0, flag)
  }
  // Paused 100 ms of it (the idle thread late, let off already): the disk let off only the other 190.
  assert.equal(diskLetOff(stretch, [{ from: 0, to: 100 }], stuck, [r]).letOffMs, 190)
  // Stuck for only 50 ms of it: 50 let off.
  assert.equal(diskLetOff(stretch, [], [{ from: 200, to: 250 }], [r]).letOffMs, 50)
})

await ok('the disk thread\'s file is beside the database, and gone once the watch is read', async () => {
  const watch = loopWatch(() => [])
  await watch.ready
  await sleep(20)
  const w = watch()
  assert.equal(path.dirname(w.diskFile), path.dirname(path.resolve(process.env.DB_PATH!)))
  await Promise.race([w.ended, sleep(5_000)])
  assert.equal(fs.existsSync(w.diskFile), false, `${w.diskFile} still there`)
})

await ok('the idle thread ends once the watch is read', async () => {
  assert.equal(idleThreadsRunning(), 0, 'an idle thread of the cases above still runs')
  const watch = loopWatch(() => [])
  await watch.ready
  assert.equal(idleThreadsRunning(), 1)
  await Promise.race([watch().ended, sleep(5_000)])
  assert.equal(idleThreadsRunning(), 0, 'the idle thread still runs')
})

if (failures > 0) { console.error(`${failures} loop-watch assertion(s) failed`); process.exit(1) }
console.log('All loop-watch assertions passed.')
