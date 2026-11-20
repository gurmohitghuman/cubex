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
// A disk thread runs beside it (loop-watch-disk.ts): a stretch is also let off the time a plain commit in it waited
// off the CPU while the disk thread's own writes were stuck too (a slow disk, not the code). The sampler reads this
// thread's CPU time each tick, so each stretch has its own. Every stretch let off for the disk is printed with its
// CPU time, the time the disk was stuck and what was let off; GC pauses are printed, never let off.
import { performance, PerformanceObserver } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'
import { covered, diskLetOff, diskThread, merged, type LetOff, type Span } from './loop-watch-disk'
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
  // The longest this thread held the loop alone: a stretch less the idle thread's lateness inside it and what it was
  // let off for the disk. That stretch (it can be another than the longest, after a pause), and the transactions
  // inside it; its CPU time, the disk thread's stuck time, what it was let off, and GC's pauses in it.
  ownMs: number
  ownStretch: { at: number; ms: number }
  inside: TransactionRecord[]
  own: LetOff & { gcMs: number }
  // Every stretch let off 1 ms or more for the disk.
  letOffs: LetOff[]
  // The disk thread's file (deleted once it stops).
  diskFile: string
  // The idle and disk threads gone.
  ended: Promise<void>
}

// Watches until the answer is called; `ready` once the idle and disk threads run. `stallDisk` (tests only): the disk
// thread's next write waits `ms`, as on a stuck disk.
export function loopWatch(records: () => TransactionRecord[]):
  (() => LoopWatched) & { ready: Promise<void>; stallDisk: (ms: number) => void } {
  const buf = new SharedArrayBuffer(8 + 8 * (1 + 2 * LATE_SLOTS))
  const workerData = { buf, tick: TICK_MS, due: DUE_MS, lateMin: LATE_MIN_MS, slots: LATE_SLOTS }
  const idle = new Worker(IDLE, { eval: true, workerData })
  idle.unref()
  running++
  idle.on('error', err => process.stderr.write(`The idle thread failed: ${String(err)}\n`))
  const idleGone = new Promise<void>(res => idle.once('exit', () => { running--; res() }))
  const idleReady = new Promise<void>(res => { idle.once('message', () => res()); void idleGone.then(res) })
  const disk = diskThread()
  const ended = Promise.all([idleGone, disk.ended]).then(() => {})
  const ready = Promise.all([idleReady, disk.ready]).then(() => {})
  const gc: Span[] = []
  const gcSeen = new PerformanceObserver(list => {
    for (const e of list.getEntries()) gc.push({ from: e.startTime, to: e.startTime + e.duration })
  })
  gcSeen.observe({ entryTypes: ['gc'] })
  // performance.now() on this thread is hrtime less this.
  const offset = hrNow() - performance.now()
  const cpuNow = () => { const c = process.threadCpuUsage(); return (c.user + c.system) / 1000 }
  let last = performance.now()
  let lastCpu = cpuNow()
  const stretches: Array<{ at: number; ms: number; cpuMs: number }> = []
  const sample = () => {
    const now = performance.now()
    const cpu = cpuNow()
    stretches.push({ at: last, ms: now - last, cpuMs: cpu - lastCpu })
    last = now
    lastCpu = cpu
  }
  const sampler = setInterval(sample, TICK_MS)
  const stop = (): LoopWatched => {
    clearInterval(sampler)
    // The stretch since the last tick too: a block that ends just before the answer the caller awaited may never
    // see the sampler run again (a timers pass uses the time it started at).
    sample()
    const now = last
    for (const e of gcSeen.takeRecords()) gc.push({ from: e.startTime, to: e.startTime + e.duration })
    gcSeen.disconnect()
    const stuck = merged(disk.stop(hrNow()).map(g => ({ from: g.from - offset, to: g.to - offset })))
    const count = Atomics.load(new Int32Array(buf, 0, 1), 0)
    const f = new Float64Array(buf, 8)
    const late: Array<{ from: number; to: number }> = []
    for (let k = 0; k < count; k++) late.push({ from: f[1 + 2 * k] - offset, to: f[2 + 2 * k] - offset })
    // Late right now (paused with the rest of the process, its next tick not run yet).
    const due = f[0] + DUE_MS
    if (f[0] > 0 && hrNow() - due >= LATE_MIN_MS) late.push({ from: due - offset, to: now })
    void idle.terminate()
    const lates = merged(late)
    const lateIn = (s: { at: number; ms: number }) => covered(lates, s.at, s.at + s.ms)
    const all = records()
    const inStretch = (s: { at: number; ms: number }) => all.filter(r => r.at < s.at + s.ms && r.at + r.ms > s.at)
    const longest = stretches.reduce((a, b) => (b.ms > a.ms ? b : a), { at: 0, ms: 0, cpuMs: 0 })
    // Records are read only for a stretch the disk was stuck in (a watch takes thousands of stretches).
    const offFor = (s: { at: number; ms: number; cpuMs: number }) =>
      diskLetOff(s, lates, stuck, covered(stuck, s.at, s.at + s.ms, lates) > 0 ? inStretch(s) : [])
    const watched = stretches.map(s => {
      const off = offFor(s)
      return { s, off, ms: s.ms - lateIn(s) - off.letOffMs }
    })
    const own = watched.reduce((a, b) => (b.ms > a.ms ? b : a),
      { s: { at: 0, ms: 0, cpuMs: 0 }, off: offFor({ at: 0, ms: 0, cpuMs: 0 }), ms: 0 })
    const gcMs = covered(merged(gc), own.s.at, own.s.at + own.s.ms)
    return { longest: { at: longest.at, ms: longest.ms }, idleMs: lateIn(longest), ownMs: own.ms,
      ownStretch: { at: own.s.at, ms: own.s.ms }, inside: inStretch(own.s), own: { ...own.off, gcMs },
      letOffs: watched.filter(x => x.off.letOffMs >= 1).map(x => x.off), diskFile: disk.file, ended }
  }
  return Object.assign(stop, { ready, stallDisk: disk.stall })
}

const n0 = (ms: number) => ms.toFixed(0)
// One stretch let off for the disk: `279 ms (CPU 16 ms, the disk stuck 250 ms, 240 ms let off)`.
export const letOffText = (o: LetOff) => `${n0(o.ms)} ms (CPU ${n0(o.cpuMs)} ms, the disk stuck ${n0(o.diskMs)} ms, `
  + `${n0(o.letOffMs)} ms let off)`
// `loop held at most 208 ms (the idle thread late 195 ms in it), by this thread alone at most 13 ms (CPU 12 ms, GC
// 0 ms); let off for the disk: none` (or each stretch let off, letOffText).
export const heldText = (w: LoopWatched) => `loop held at most ${n0(w.longest.ms)} ms (the idle thread late `
  + `${n0(w.idleMs)} ms in it), by this thread alone at most ${n0(w.ownMs)} ms (CPU ${n0(w.own.cpuMs)} ms, GC `
  + `${n0(w.own.gcMs)} ms); let off for the disk: ${w.letOffs.map(letOffText).join(', ') || 'none'}`

// `fn` run under a watch: its answer, how long it took, and the watch, read once fn ended or threw (so its threads
// end and the disk thread's file is deleted either way). The watch is printed when a stretch was let off.
export async function watchWhile<T>(records: () => TransactionRecord[], fn: () => Promise<T>):
  Promise<{ out: T; ms: number; watched: LoopWatched }> {
  const watch = loopWatch(records)
  await watch.ready
  const t = performance.now()
  let watched: LoopWatched | undefined
  try {
    const out = await fn()
    const ms = performance.now() - t
    watched = watch()
    return { out, ms, watched }
  } finally {
    watched ??= watch()
    if (watched.letOffs.length > 0) console.log(`      ${heldText(watched)}`)
  }
}
