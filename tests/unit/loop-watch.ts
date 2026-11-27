// Over 200 lines: the loop watch and its printed text, which every loop-bound test reads.
// The event loop watched while code under test runs (bulk-wal-kit.ts and the tests that time a job), with a second
// clock that tells this thread holding the loop from the whole process being paused. The loop is sampled every 5 ms:
// its longest stretch, the one this thread held longest, and the transactions of `records` inside that one. Meanwhile
// an idle worker thread runs a 5 ms timer and nothing else (no I/O, no database): it runs late only when the process
// itself couldn't run (the runner's VM paused, or had no CPU for it). A stretch of the loop, less the time the idle
// thread ran late inside it, is what this thread held alone: a transaction busy on the CPU or waiting on the disk
// counts in full, the idle thread running on meanwhile (`ownMs`), so a stretch is let off only when the idle thread
// ran late for nearly all of it (at least the stretch less the bound). That lateness is printed with the longest
// stretch either way (heldText). The idle thread ends when the watch is read and never keeps the process running; a
// watch read before the thread had started (`ready`) lets off nothing from before then.
// On Linux the kernel says where this thread waited (loop-watch-waits.ts): a stretch is also let off its time
// waiting for a CPU, and its plain commits' time in a disk wait point. Elsewhere a disk thread runs beside it
// (loop-watch-disk.ts): a stretch is also let off the time a plain commit in it waited off the CPU while the disk
// thread's own writes were stuck too (a slow disk, not the code). The sampler reads this thread's CPU time each tick,
// so each stretch has its own. Every stretch let off is printed with its CPU time and where what was let off came
// from; GC pauses are printed, never let off.
// What a test bounds depends on what it proves. One about how much work the code does at a time (a bulk job's slices,
// a clear, a transform, a summary) bounds `cpuMs`: the most CPU time this thread spent in one stretch, GC's included,
// or `cpuWith` where the code also waits off the CPU on purpose (the formula engine). A busy machine or a slow runner
// stretches the wall clock more than that: run-clear-big, transform-formula-follow and hiring-summarize-big went over
// their bounds by 7 to 102 ms under load (two full unit runs on one server, a busy Mac, a Windows runner) and passed
// alone. CPU time still rises some under load (a shared core, a lower clock), so the margins stay. What holds such a
// job off the CPU is checked as an event where there is one: a transaction begun while a checkpoint ran
// (bulk-wal-kit.ts checkpointOverlaps), one that ran SQLite's own checkpoint, started the WAL over or grew the -wal
// file (sqlite-write-probe.ts). Other waits off the CPU (a lock's busy handler, a disk wait outside a plain commit)
// that cpuMs doesn't see stay a test's own: one that proves this thread doesn't wait (for a lock, a checkpoint or
// another thread) bounds `ownMs`, as a wait takes no CPU time. On Windows a thread's CPU time moves in clock ticks of
// about 15.6 ms.
import path from 'node:path'
import { performance, PerformanceObserver } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'
import { covered, diskLetOff, diskThread, merged, type LetOff, type Span } from './loop-watch-disk'
import { byWaitPoint, runQueue, waitLetOff, waitsThread, type WaitSpan } from './loop-watch-waits'
import { transactionLine, type TransactionRecord } from './sqlite-write-probe'

const TICK_MS = 5
// A stretch let off this much or more is listed on its own (heldText); all are in the total.
const LISTED_MS = 10
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

// Every watch read in this process, summed, and printed once as it exits: what was let off and from where, and the
// most let off one stretch, with what this thread held alone of it (a test's bound applies to that).
const summed = { watches: 0, ms: 0, stretches: 0, from: new Map<string, number>(), most: { off: 0, ms: 0, own: 0 } }
process.on('exit', () => {
  if (summed.watches === 0) return
  const from = [...summed.from].map(([what, ms]) => `${what} ${ms.toFixed(0)} ms`).join(', ')
  const { most } = summed
  process.stdout.write(`loop watch, ${path.basename(process.argv[1] ?? '')}: ${summed.watches} watches; let off `
    + `${summed.ms.toFixed(0)} ms in ${summed.stretches} stretches${from ? ` (${from})` : ''}; the most off one `
    + `stretch: ${most.off.toFixed(0)} ms of ${most.ms.toFixed(0)} ms (${most.own.toFixed(0)} ms held alone)\n`)
})

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
  // The most CPU time this thread spent in one stretch (a work test's bound, above), that stretch, and the
  // transactions inside it.
  cpuMs: number
  cpuStretch: { at: number; ms: number }
  cpuInside: TransactionRecord[]
  // The most this thread spent in one stretch on the CPU and in `spans` (performance.now() times): waits off the CPU
  // the code under test owns, such as the formula engine's (lib/formula/host.ts blocks in Atomics.wait), which
  // `cpuMs` leaves out. That stretch, and how long it was.
  cpuWith: (spans: Span[]) => { ms: number; at: number; stretchMs: number }
  own: LetOff & { gcMs: number }
  // All that was let off: how much, over how many stretches, and from where. Each stretch let off LISTED_MS or more.
  letOffTotal: { ms: number; stretches: number; from: Array<[string, number]> }
  letOffs: LetOff[]
  // The disk thread's file (deleted once it stops); '' on Linux, which has none.
  diskFile: string
  // The idle thread and the disk or waits thread gone.
  ended: Promise<void>
}
// Tests only: `mode` 'disk' runs the disk thread on Linux too; `wchan`, another file read as this thread's wait point.
export interface WatchOptions { mode?: 'waits' | 'disk'; wchan?: string }

// Watches until the answer is called; `ready` once its threads run. `stallDisk` (tests only): the disk thread's next
// write waits `ms`, as on a stuck disk.
export function loopWatch(records: () => TransactionRecord[], opts: WatchOptions = {}):
  (() => LoopWatched) & { ready: Promise<void>; stallDisk: (ms: number) => void } {
  const mode = opts.mode ?? (process.platform === 'linux' ? 'waits' : 'disk')
  const buf = new SharedArrayBuffer(8 + 8 * (1 + 2 * LATE_SLOTS))
  const workerData = { buf, tick: TICK_MS, due: DUE_MS, lateMin: LATE_MIN_MS, slots: LATE_SLOTS }
  const idle = new Worker(IDLE, { eval: true, workerData })
  idle.unref()
  running++
  idle.on('error', err => process.stderr.write(`The idle thread failed: ${String(err)}\n`))
  const idleGone = new Promise<void>(res => idle.once('exit', () => { running--; res() }))
  const idleReady = new Promise<void>(res => { idle.once('message', () => res()); void idleGone.then(res) })
  const disk = mode === 'disk' ? diskThread() : null
  const waits = mode === 'waits' ? waitsThread(opts.wchan) : null
  const rq = mode === 'waits' ? runQueue() : null
  const side = disk ?? waits!
  const ended = Promise.all([idleGone, side.ended]).then(() => {})
  const ready = Promise.all([idleReady, side.ready]).then(() => {})
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
  let lastRq = rq?.read() ?? null
  const stretches: Array<{ at: number; ms: number; cpuMs: number; rqMs: number }> = []
  const sample = () => {
    const now = performance.now()
    const cpu = cpuNow()
    const queued = rq?.read() ?? null
    stretches.push({ at: last, ms: now - last, cpuMs: cpu - lastCpu,
      rqMs: queued !== null && lastRq !== null ? Math.max(0, queued - lastRq) : 0 })
    last = now
    lastCpu = cpu
    lastRq = queued
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
    const stuck = merged((disk?.stop(hrNow()) ?? []).map(g => ({ from: g.from - offset, to: g.to - offset })))
    const waited: WaitSpan[] = (waits?.stop() ?? []).map(g => ({ ...g, from: g.from - offset, to: g.to - offset }))
    const waitedAll = merged(waited)
    const waitedBy = byWaitPoint(waited)
    rq?.close()
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
    const longest = stretches.reduce((a, b) => (b.ms > a.ms ? b : a), { at: 0, ms: 0, cpuMs: 0, rqMs: 0 })
    // Records are read only for a stretch the disk was stuck or waited on in (a watch takes thousands of stretches).
    type Stretch = { at: number; ms: number; cpuMs: number; rqMs: number }
    const offFor = (s: Stretch) => (mode === 'waits'
      ? waitLetOff(s, lates, waitedBy, covered(waitedAll, s.at, s.at + s.ms) > 0 ? inStretch(s) : [])
      : diskLetOff(s, lates, stuck, covered(stuck, s.at, s.at + s.ms, lates) > 0 ? inStretch(s) : []))
    const watched = stretches.map(s => {
      const off = offFor(s)
      return { s, off, ms: s.ms - lateIn(s) - off.letOffMs }
    })
    const none = { at: 0, ms: 0, cpuMs: 0, rqMs: 0 }
    const own = watched.reduce((a, b) => (b.ms > a.ms ? b : a), { s: none, off: offFor(none), ms: 0 })
    const cpu = stretches.reduce((a, b) => (b.cpuMs > a.cpuMs ? b : a), none)
    const cpuWith = (spans: Span[]) => {
      const m = merged(spans)
      return stretches.reduce((a, s) => {
        const ms = s.cpuMs + covered(m, s.at, s.at + s.ms)
        return ms > a.ms ? { ms, at: s.at, stretchMs: s.ms } : a
      }, { ms: 0, at: 0, stretchMs: 0 })
    }
    const gcMs = covered(merged(gc), own.s.at, own.s.at + own.s.ms)
    const total = new Map<string, number>()
    const offs = watched.filter(x => x.off.letOffMs >= 0.5).map(x => x.off)
    for (const o of offs) {
      for (const [what, ms] of o.from ?? [['the disk stuck', o.letOffMs]]) total.set(what, (total.get(what) ?? 0) + ms)
    }
    const letOffTotal = { ms: offs.reduce((a, o) => a + o.letOffMs, 0), stretches: offs.length, from: [...total] }
    summed.watches++
    summed.ms += letOffTotal.ms
    summed.stretches += offs.length
    for (const [what, ms] of total) summed.from.set(what, (summed.from.get(what) ?? 0) + ms)
    for (const x of watched) {
      if (x.off.letOffMs > summed.most.off) summed.most = { off: x.off.letOffMs, ms: x.s.ms, own: x.ms }
    }
    return { longest: { at: longest.at, ms: longest.ms }, idleMs: lateIn(longest), ownMs: own.ms,
      ownStretch: { at: own.s.at, ms: own.s.ms }, inside: inStretch(own.s), own: { ...own.off, gcMs },
      cpuMs: cpu.cpuMs, cpuStretch: { at: cpu.at, ms: cpu.ms }, cpuInside: inStretch(cpu), cpuWith,
      letOffTotal, letOffs: offs.filter(o => o.letOffMs >= LISTED_MS), diskFile: disk?.file ?? '', ended }
  }
  return Object.assign(stop, { ready, stallDisk: disk?.stall ?? (() => {}) })
}

const n0 = (ms: number) => ms.toFixed(0)
// One stretch let off: `279 ms (CPU 16 ms, the disk stuck 250 ms, 240 ms let off)` (the disk thread), or
// `262 ms (CPU 77 ms, 170 ms let off: __wait_on_buffer 160 ms, waiting for a CPU 10 ms)` (Linux).
export const letOffText = (o: LetOff) => `${n0(o.ms)} ms (CPU ${n0(o.cpuMs)} ms, ` + (o.from
  ? `${n0(o.letOffMs)} ms let off: ${o.from.map(([what, ms]) => `${what} ${n0(ms)} ms`).join(', ')})`
  : `the disk stuck ${n0(o.diskMs)} ms, ${n0(o.letOffMs)} ms let off)`)
// All let off: `160 ms in 12 stretches (__wait_on_buffer 147 ms, waiting for a CPU 13 ms); each 10 ms or more: `
// and each such stretch (letOffText); or `none`.
const totalText = (w: LoopWatched) => (w.letOffTotal.stretches === 0 ? 'none'
  : `${n0(w.letOffTotal.ms)} ms in ${w.letOffTotal.stretches} stretch${w.letOffTotal.stretches === 1 ? '' : 'es'} (`
  + `${w.letOffTotal.from.map(([what, ms]) => `${what} ${n0(ms)} ms`).join(', ')}); each ${LISTED_MS} ms or more: `
  + `${w.letOffs.map(letOffText).join(', ') || 'none'}`)
// `loop held at most 208 ms (the idle thread late 195 ms in it), by this thread alone at most 13 ms (CPU 12 ms, GC
// 0 ms), on the CPU at most 12 ms in one stretch (of 13 ms); let off: none` (or totalText).
export const heldText = (w: LoopWatched) => `loop held at most ${n0(w.longest.ms)} ms (the idle thread late `
  + `${n0(w.idleMs)} ms in it), by this thread alone at most ${n0(w.ownMs)} ms (CPU ${n0(w.own.cpuMs)} ms, GC `
  + `${n0(w.own.gcMs)} ms), on the CPU at most ${n0(w.cpuMs)} ms in one stretch (of ${n0(w.cpuStretch.ms)} ms); `
  + `let off: ${totalText(w)}`

// `fn` run under a watch: its answer, how long it took, and the watch, read once fn ended or threw (so its threads
// end and the disk thread's file is deleted either way). The watch is printed when a stretch was let off, or this
// thread held the loop `printFrom` ms or more: then with the transactions in that stretch.
export async function watchWhile<T>(records: () => TransactionRecord[], fn: () => Promise<T>, printFrom = Infinity):
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
    const over = watched.ownMs >= printFrom
    if (over || watched.letOffs.length > 0) console.log(`      ${heldText(watched)}`)
    if (over) console.log(`      in it: ${watched.inside.map(transactionLine).join(' | ') || 'no transaction'}`)
  }
}
