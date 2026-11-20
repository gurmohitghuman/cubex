// The event loop watched while code under test runs (bulk-wal-kit.ts and the tests that time a job), with a second
// clock that tells this thread holding the loop from the whole process being paused. The loop is sampled every 5 ms:
// its longest stretch, the one this thread held longest, and the transactions of `records` inside that one. Meanwhile
// an idle worker thread runs a 5 ms timer and nothing else (no I/O, no database): it runs late only when the process
// itself couldn't run (the runner's VM paused, or had no CPU for it). A stretch of the loop, less the time the idle
// thread ran late inside it, is what this thread held alone: a transaction busy on the CPU or waiting on the disk
// counts in full, the idle thread running on meanwhile. A test's loop bound applies to that (`ownMs`), so a stretch is
// let off only when the idle thread ran late for nearly all of it (at least the stretch less the bound). That lateness
// is printed with the longest stretch either way (heldText). The idle thread ends when the watch is read and never
// keeps the process running; a watch read before the thread had started (`ready`) lets off nothing from before then.
import { performance } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'
import type { TransactionRecord } from './sqlite-write-probe'

const TICK_MS = 5
// A tick of the idle thread counts as on time up to DUE_MS after the one before: on Windows timers run in clock ticks
// of about 15.6 ms, so a 5 ms timer runs about every 16 ms there. Late by LATE_MIN_MS or less past that is the
// scheduler's jitter, not a pause: not recorded.
const DUE_MS = 16
const LATE_MIN_MS = 10
const LATE_SLOTS = 16_384
// Every thread's clock: process.hrtime in ms.
const hrNow = () => Number(process.hrtime.bigint()) / 1e6
// The idle thread. In `buf`: an Int32 count, then doubles: its last tick, and each time it ran late (from when its
// tick was due to when it ran).
const IDLE = `
const { workerData: { buf, tick, due, lateMin, slots }, parentPort } = require('node:worker_threads')
const count = new Int32Array(buf, 0, 1)
const f = new Float64Array(buf, 8)
const now = () => Number(process.hrtime.bigint()) / 1e6
let last = now()
f[0] = last
setInterval(() => {
  const t = now()
  const n = Atomics.load(count, 0)
  if (t - last - due >= lateMin && n < slots) {
    f[1 + 2 * n] = last + due
    f[2 + 2 * n] = t
    Atomics.store(count, 0, n + 1)
  }
  last = t
  f[0] = t
}, tick)
parentPort.postMessage('ready')
`

let running = 0
// Tests only: idle threads started and not yet ended.
export const idleThreadsRunning = (): number => running

export interface LoopWatched {
  // The loop's longest stretch (`at`: performance.now() at its start), and how long the idle thread ran late in it.
  longest: { at: number; ms: number }
  idleMs: number
  // The longest this thread held the loop alone: a stretch less the idle thread's lateness inside it. That stretch
  // (it can be another than the longest, after a pause), and the transactions inside it.
  ownMs: number
  ownStretch: { at: number; ms: number }
  inside: TransactionRecord[]
  // The idle thread gone.
  ended: Promise<void>
}

// Watches until the answer is called; `ready` once the idle thread runs.
export function loopWatch(records: () => TransactionRecord[]): (() => LoopWatched) & { ready: Promise<void> } {
  const buf = new SharedArrayBuffer(8 + 8 * (1 + 2 * LATE_SLOTS))
  const workerData = { buf, tick: TICK_MS, due: DUE_MS, lateMin: LATE_MIN_MS, slots: LATE_SLOTS }
  const idle = new Worker(IDLE, { eval: true, workerData })
  idle.unref()
  running++
  idle.on('error', err => process.stderr.write(`The idle thread failed: ${String(err)}\n`))
  const ended = new Promise<void>(res => idle.once('exit', () => { running--; res() }))
  const ready = new Promise<void>(res => { idle.once('message', () => res()); void ended.then(res) })
  // performance.now() on this thread is hrtime less this.
  const offset = hrNow() - performance.now()
  let last = performance.now()
  const stretches: Array<{ at: number; ms: number }> = []
  const sampler = setInterval(() => {
    const now = performance.now()
    stretches.push({ at: last, ms: now - last })
    last = now
  }, TICK_MS)
  const stop = (): LoopWatched => {
    clearInterval(sampler)
    // The stretch since the last tick too: a block that ends just before the answer the caller awaited may never
    // see the sampler run again (a timers pass uses the time it started at).
    const now = performance.now()
    stretches.push({ at: last, ms: now - last })
    const count = Atomics.load(new Int32Array(buf, 0, 1), 0)
    const f = new Float64Array(buf, 8)
    const late: Array<{ from: number; to: number }> = []
    for (let k = 0; k < count; k++) late.push({ from: f[1 + 2 * k] - offset, to: f[2 + 2 * k] - offset })
    // Late right now (paused with the rest of the process, its next tick not run yet).
    const due = f[0] + DUE_MS
    if (f[0] > 0 && hrNow() - due >= LATE_MIN_MS) late.push({ from: due - offset, to: now })
    void idle.terminate()
    const lateIn = (s: { at: number; ms: number }) => late.reduce((sum, g) =>
      sum + Math.max(0, Math.min(g.to, s.at + s.ms) - Math.max(g.from, s.at)), 0)
    const longest = stretches.reduce((a, b) => (b.ms > a.ms ? b : a), { at: 0, ms: 0 })
    const own = stretches.map(s => ({ s, ms: s.ms - lateIn(s) }))
      .reduce((a, b) => (b.ms > a.ms ? b : a), { s: { at: 0, ms: 0 }, ms: 0 })
    const inside = records().filter(r => r.at < own.s.at + own.s.ms && r.at + r.ms > own.s.at)
    return { longest, idleMs: lateIn(longest), ownMs: own.ms, ownStretch: own.s, inside, ended }
  }
  return Object.assign(stop, { ready })
}

// `loop held at most 208 ms (the idle thread late 195 ms in it), by this thread alone at most 13 ms`.
export const heldText = (w: LoopWatched) => `loop held at most ${w.longest.ms.toFixed(0)} ms (the idle thread late `
  + `${w.idleMs.toFixed(0)} ms in it), by this thread alone at most ${w.ownMs.toFixed(0)} ms`
