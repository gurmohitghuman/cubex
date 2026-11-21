// Where this thread waited, on Linux (loop-watch.ts): instead of the disk thread (loop-watch-disk.ts), the kernel is
// asked directly. A thread of its own reads this thread's wait point (/proc/<pid>/task/<pid>/wchan) every WAIT_TICK_MS
// and records the time spent in DISK_WAITS, each by name; the sampler reads this thread's time waiting for a CPU
// (/proc/thread-self/schedstat) each tick, so each stretch of the loop has its own. A stretch is let off:
// - its time waiting for a CPU, wherever it waited (other processes, or this one's other threads, had the CPUs);
// - the time its plain commits spent in a disk wait point, at most their time off the CPU less the time waiting for
//   a CPU. A commit's frames are 4,120 bytes, so writing into a WAL page no longer in memory reads it from disk first
//   (__wait_on_buffer); a slow or busy disk shows in the others.
// It fails closed: a wait point not named here, one that reads "0" or can't be read at all lets off nothing, nor
// does a schedstat that can't be read. Never let off: CPU time, futex waits (a lock, the worker, Atomics.wait), GC,
// and any disk wait outside a plain commit or in one that syncs (it started the WAL over, ran SQLite's own
// checkpoint, or began while a checkpoint asked of the worker was pending): a sync the code asks for always counts.
import fs from 'node:fs'
import { Worker } from 'node:worker_threads'
import { covered, merged, type LetOff, type Span } from './loop-watch-disk'
import type { TransactionRecord } from './sqlite-write-probe'

// The kernel waiting on the disk: a block read or write in flight (a page read back before a write that covers only
// part of it), a page under read or write-back, the block layer's write throttling, too many dirty pages, ext4's
// journal busy writing, the disk's queue full.
export const DISK_WAITS = ['__wait_on_buffer', 'folio_wait_bit_common', 'rq_qos_wait', 'balance_dirty_pages',
  'do_get_write_access', 'wait_transaction_locked', 'jbd2_log_wait_commit', 'blk_mq_get_tag']
const WAIT_TICK_MS = 2
const SLOTS = 32_768
export interface WaitSpan extends Span { kind: number }

// In `buf`: Int32 [count, stop], then doubles: each span's start, end (process.hrtime in ms) and wait point's index
// in DISK_WAITS. A sample in a disk wait point counts the time since the sample before it, two ticks at most (this
// thread late, it can't tell how long the other waited).
const WAITS = `
const fs = require('node:fs')
const { workerData: { buf, file, tick, names, slots }, parentPort } = require('node:worker_threads')
const ints = new Int32Array(buf, 0, 2)
const f = new Float64Array(buf, 8)
const now = () => Number(process.hrtime.bigint()) / 1e6
let fd = -1
try { fd = fs.openSync(file, 'r') } catch {}
const b = Buffer.alloc(128)
let last = now()
const timer = setInterval(() => {
  if (Atomics.load(ints, 1) === 1) {
    clearInterval(timer)
    if (fd >= 0) fs.closeSync(fd)
    parentPort.close()
    return
  }
  const t = now()
  let kind = -1
  if (fd >= 0) try { kind = names.indexOf(b.toString('latin1', 0, fs.readSync(fd, b, 0, 128, 0)).trim()) } catch {}
  const n = Atomics.load(ints, 0)
  const from = Math.max(last, t - 2 * tick)
  if (kind >= 0 && n > 0 && f[3 * n - 1] === kind && f[3 * n - 2] === from) f[3 * n - 2] = t
  else if (kind >= 0 && n < slots) {
    f[3 * n] = from; f[3 * n + 1] = t; f[3 * n + 2] = kind
    Atomics.store(ints, 0, n + 1)
  }
  last = t
}, tick)
parentPort.postMessage('ready')
`

// The thread reading this one's wait point; `wchan` (tests only) another file to read, as where it can't be read.
export function waitsThread(wchan = `/proc/${process.pid}/task/${process.pid}/wchan`) {
  const buf = new SharedArrayBuffer(8 + 8 * 3 * SLOTS)
  const ints = new Int32Array(buf, 0, 2)
  const workerData = { buf, file: wchan, tick: WAIT_TICK_MS, names: DISK_WAITS, slots: SLOTS }
  const worker = new Worker(WAITS, { eval: true, workerData })
  worker.unref()
  worker.on('error', err => process.stderr.write(`The waits thread failed: ${String(err)}\n`))
  const ended = new Promise<void>(res => worker.once('exit', () => res()))
  const ready = new Promise<void>(res => { worker.once('message', () => res()); void ended.then(res) })
  return {
    ready, ended,
    // The spans in disk wait points so far (in hrtime ms), and then it stops.
    stop(): WaitSpan[] {
      const f = new Float64Array(buf, 8)
      const out: WaitSpan[] = []
      for (let k = 0; k < Atomics.load(ints, 0); k++) out.push({ from: f[3 * k], to: f[3 * k + 1], kind: f[3 * k + 2] })
      Atomics.store(ints, 1, 1)
      return out
    },
  }
}

// This thread's time waiting for a CPU so far, in ms; null where schedstat can't be read (not Linux, or hidden).
export function runQueue(): { read: () => number | null; close: () => void } {
  let fd = -1
  try { fd = fs.openSync('/proc/thread-self/schedstat', 'r') } catch { /* not readable: nothing let off */ }
  const b = Buffer.alloc(128)
  return {
    read() {
      if (fd < 0) return null
      try {
        const ns = Number(b.toString('latin1', 0, fs.readSync(fd, b, 0, 128, 0)).split(' ')[1])
        return Number.isFinite(ns) ? ns / 1e6 : null
      } catch { return null }
    },
    close() { if (fd >= 0) fs.closeSync(fd) },
  }
}

const syncs = (r: TransactionRecord) => r.startedOver || r.ownCheckpoint || r.checkpointing

// The disk wait spans by wait point (DISK_WAITS' order), each merged: what waitLetOff reads.
export const byWaitPoint = (waits: WaitSpan[]): Span[][] =>
  DISK_WAITS.map((_, k) => merged(waits.filter(w => w.kind === k)))

// What the stretch [at, at + ms) is let off: `rqMs`, its time waiting for a CPU; `late` (merged) the idle thread's
// lateness, let off already; `waits` the disk wait spans (byWaitPoint), in the same clock as `at`.
export function waitLetOff(stretch: { at: number; ms: number; cpuMs: number; rqMs: number }, late: Span[],
  waits: Span[][], records: TransactionRecord[]): LetOff {
  const { at, ms, cpuMs, rqMs } = stretch
  const end = at + ms
  const plain = records.filter(r => !syncs(r))
  // Each plain commit's share of the stretch, and the disk wait time inside those, by wait point.
  const spans = plain.map(r => ({ from: Math.max(at, r.at), to: Math.min(end, r.at + r.ms) }))
  const byKind = waits.map(kind => spans.reduce((sum, s) => sum + (s.to > s.from ? covered(kind, s.from, s.to) : 0), 0))
  const offCpuMs = plain.reduce((sum, r, i) => {
    const share = Math.max(0, spans[i].to - spans[i].from)
    return sum + (r.ms > 0 ? Math.max(0, r.ms - r.cpuMs) * (share / r.ms) : 0)
  }, 0)
  const sampled = byKind.reduce((a, b) => a + b, 0)
  const disk = Math.min(sampled, Math.max(0, offCpuMs - rqMs))
  const room = Math.max(0, ms - covered(late, at, end) - cpuMs)
  const letOffMs = Math.min(room, rqMs + disk)
  const scale = rqMs + disk > 0 ? letOffMs / (rqMs + disk) : 0
  const from: Array<[string, number]> = DISK_WAITS.map((name, k): [string, number] =>
    [name, sampled > 0 ? byKind[k] * (disk / sampled) * scale : 0])
  from.push(['waiting for a CPU', rqMs * scale])
  return { at, ms, cpuMs, diskMs: sampled, offCpuMs, letOffMs, from: from.filter(([, v]) => v >= 0.5) }
}
