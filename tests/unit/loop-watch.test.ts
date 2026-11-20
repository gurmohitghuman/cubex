// The loop watch's own check (loop-watch.ts): a hold of the event loop by this thread alone still counts in full
// against a bound while the idle thread runs on, whether the thread was busy on the CPU (a transaction working 250 ms)
// or waiting (a write waiting 250 ms for SQLite's write lock, held on another thread); a pause of the whole process
// (SIGSTOP, then SIGCONT 300 ms later; not on Windows, which has no such signal) is let off, and printed; the idle
// thread ends once the watch is read.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import dbMod from '../../server/src/lib/db'
import { heldText, idleThreadsRunning, loopWatch, type LoopWatched } from './loop-watch'
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

// `hold` watched, the loop then left free a moment so the sampler sees the stretch end; printed.
async function watched(label: string, hold: () => Promise<void> | void): Promise<LoopWatched> {
  probe.reset()
  const watch = loopWatch(probe.records)
  await watch.ready
  await sleep(20)
  try { await hold() } finally { await sleep(20) }
  const w = watch()
  console.log(`      ${label}: ${heldText(w)}; ${w.inside.map(transactionLine).join(' | ') || 'no transaction'}`)
  await Promise.race([w.ended, sleep(5_000)])
  return w
}
const held = (w: LoopWatched) => assert.ok(w.ownMs >= BOUND_MS && w.idleMs < w.longest.ms - BOUND_MS,
  `held ${w.ownMs.toFixed(0)} ms by this thread alone (the idle thread late ${w.idleMs.toFixed(0)} ms): let off`)

await ok(`a transaction busy on the CPU ${HOLD_MS} ms: held by this thread alone, past the bound`, async () => {
  const w = await watched('busy', () => {
    db.transaction(() => {
      add.run(1)
      for (const end = performance.now() + HOLD_MS; performance.now() < end;) { /* busy */ }
    }).immediate()
  })
  held(w)
  const [r] = w.inside
  assert.ok(r && r.ms >= HOLD_MS && r.cpuMs >= 0.6 * r.ms, `the transaction: ${r ? transactionLine(r) : 'none'}`)
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
  const w = await watched('paused', () => new Promise<void>((res, rej) => {
    const pid = process.pid
    spawn('sh', ['-c', `kill -STOP ${pid}; sleep 0.3; kill -CONT ${pid}`], { stdio: 'ignore' })
      .once('exit', code => (code === 0 ? res() : rej(new Error(`the pause exited ${code}`))))
  }))
  assert.ok(w.longest.ms >= 250, `the loop held only ${w.longest.ms.toFixed(0)} ms`)
  assert.ok(w.ownMs < BOUND_MS && w.idleMs >= w.longest.ms - BOUND_MS,
    `held ${w.ownMs.toFixed(0)} ms by this thread alone (the idle thread late ${w.idleMs.toFixed(0)} ms)`)
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
