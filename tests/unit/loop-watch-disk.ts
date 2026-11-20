// The disk side of the loop watch (loop-watch.ts): a thread that writes to the disk the database is on and records
// when its writes were stuck, and what a stretch of the loop is let off for it. A plain commit (WAL with
// synchronous = NORMAL, lib/db.ts) writes its frames with buffered writes and syncs nothing, so a commit that took
// far longer than its CPU time waited on the OS for those writes. When this thread's own buffered writes to the same
// disk were stuck at the same time, the disk was slow for everyone, not the code. A stretch is let off the smaller
// of: the time the disk thread was stuck in it (less the time the whole process was paused, let off already), and
// the time the plain commits in it spent off the CPU. CPU time, lock and worker waits outside a stuck disk, a commit
// that syncs (it started the WAL over, ran SQLite's own checkpoint, or began while a checkpoint asked of the worker
// was pending) and GC always count.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { TransactionRecord } from './sqlite-write-probe'

export interface Span { from: number; to: number }

// Every TICK_MS the disk thread appends one PAGE to its file, and starts the file over once it holds FILE_BYTES. A
// write (or start over) that took SLOW_MS or more is recorded, up to SLOTS of them.
const TICK_MS = 5
const PAGE = 4096
const FILE_BYTES = 1 << 20
const SLOW_MS = 10
const SLOTS = 16_384
// In `buf`: Int32 [count, stop, stall ms], then doubles: when the write in hand began (0 when none), then each stuck
// write's start and end (process.hrtime in ms). `stall` (tests only) makes the next write wait that long, as a stuck
// disk would.
const DISK = `
const fs = require('node:fs')
const { workerData: { buf, file, tick, page, fileBytes, slowMs, slots }, parentPort } = require('node:worker_threads')
const ints = new Int32Array(buf, 0, 3)
const f = new Float64Array(buf, 16)
const now = () => Number(process.hrtime.bigint()) / 1e6
const fd = fs.openSync(file, 'w')
const bytes = Buffer.alloc(page, 7)
let size = 0
const timer = setInterval(() => {
  if (Atomics.load(ints, 1) === 1) {
    clearInterval(timer)
    fs.closeSync(fd)
    fs.rmSync(file, { force: true })
    parentPort.close()
    return
  }
  const t0 = now()
  f[0] = t0
  const stall = Atomics.exchange(ints, 2, 0)
  if (stall > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stall)
  if (size >= fileBytes) { fs.ftruncateSync(fd, 0); size = 0 }
  fs.writeSync(fd, bytes, 0, page, size)
  size += page
  const t1 = now()
  f[0] = 0
  const n = Atomics.load(ints, 0)
  if (t1 - t0 >= slowMs && n < slots) {
    f[1 + 2 * n] = t0
    f[2 + 2 * n] = t1
    Atomics.store(ints, 0, n + 1)
  }
}, tick)
parentPort.postMessage('ready')
`

let seq = 0
// The disk thread, its file in the test's own folder (beside DB_PATH: the same disk), deleted when it stops.
export function diskThread() {
  const buf = new SharedArrayBuffer(16 + 8 * (1 + 2 * SLOTS))
  const ints = new Int32Array(buf, 0, 3)
  const dir = process.env.DB_PATH ? path.dirname(path.resolve(process.env.DB_PATH)) : os.tmpdir()
  const file = path.join(dir, `loop-watch-disk-${process.pid}-${++seq}.bin`)
  const workerData = { buf, file, tick: TICK_MS, page: PAGE, fileBytes: FILE_BYTES, slowMs: SLOW_MS, slots: SLOTS }
  const worker = new Worker(DISK, { eval: true, workerData })
  worker.unref()
  worker.on('error', err => process.stderr.write(`The disk thread failed: ${String(err)}\n`))
  const ended = new Promise<void>(res => worker.once('exit', () => res()))
  const ready = new Promise<void>(res => { worker.once('message', () => res()); void ended.then(res) })
  return {
    file, ready, ended,
    // Tests only: the disk thread's next write waits `ms`, as on a stuck disk.
    stall: (ms: number) => { Atomics.store(ints, 2, Math.round(ms)) },
    // Its stuck writes so far (in hrtime ms; one stuck right now counts up to `now`), and then it stops.
    stop(now: number): Span[] {
      const f = new Float64Array(buf, 16)
      const stuck: Span[] = []
      for (let k = 0; k < Atomics.load(ints, 0); k++) stuck.push({ from: f[1 + 2 * k], to: f[2 + 2 * k] })
      if (f[0] > 0 && now - f[0] >= SLOW_MS) stuck.push({ from: f[0], to: now })
      Atomics.store(ints, 1, 1)
      return stuck
    },
  }
}

// Spans sorted and joined where they touch.
export function merged(spans: Span[]): Span[] {
  const out: Span[] = []
  for (const s of [...spans].sort((a, b) => a.from - b.from)) {
    const last = out[out.length - 1]
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to)
    else if (s.to > s.from) out.push({ ...s })
  }
  return out
}
// How long `spans` (merged) cover of [from, to), less what `minus` (merged) covers.
export function covered(spans: Span[], from: number, to: number, minus: Span[] = []): number {
  let ms = 0
  for (const s of spans) {
    const a = Math.max(s.from, from)
    const b = Math.min(s.to, to)
    if (b <= a) continue
    ms += b - a
    for (const m of minus) ms -= Math.max(0, Math.min(b, m.to) - Math.max(a, m.from))
  }
  return Math.max(0, ms)
}

// A commit that syncs, or may wait on the checkpoint worker: never let off.
const syncs = (r: TransactionRecord) => r.startedOver || r.ownCheckpoint || r.checkpointing

export interface LetOff { at: number; ms: number; cpuMs: number; diskMs: number; offCpuMs: number; letOffMs: number }

// What the stretch [at, at + ms) is let off for the disk: `late` and `stuck` merged, in the same clock as `at`.
export function diskLetOff(stretch: { at: number; ms: number; cpuMs: number }, late: Span[], stuck: Span[],
  records: TransactionRecord[]): LetOff {
  const { at, ms, cpuMs } = stretch
  const end = at + ms
  const diskMs = covered(stuck, at, end, late)
  // Each plain commit's time off the CPU, the share of it inside the stretch.
  const offCpuMs = records.filter(r => !syncs(r)).reduce((sum, r) => {
    const inside = Math.max(0, Math.min(end, r.at + r.ms) - Math.max(at, r.at))
    return sum + (r.ms > 0 ? Math.max(0, r.ms - r.cpuMs) * (inside / r.ms) : 0)
  }, 0)
  const room = Math.max(0, ms - covered(late, at, end) - cpuMs)
  return { at, ms, cpuMs, diskMs, offCpuMs, letOffMs: Math.min(diskMs, offCpuMs, room) }
}
