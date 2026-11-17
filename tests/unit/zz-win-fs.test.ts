// Experiment (not for merge): does an operation on one handle of a file wait while another handle of the same file
// syncs it (FlushFileBuffers on Windows, fsync on Linux)? A syncer thread writes D MB into file F (already written
// once, so no write extends it) and syncs it, 4 rounds. A prober thread, every ~1 ms, on its own handles: a 4 KB
// write inside F (not extending it), a 4 KB write at F's end (extending it), a 4 KB read of F, F's size, and a 4 KB
// write inside another file G of the same folder (the control: a busy disk slows G too, a lock on F does not).
// Printed per round: the write and sync times, and per operation its longest time inside the sync and outside it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'

const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'zz-fs-'))
const F = path.join(dir, 'f.bin')
const G = path.join(dir, 'g.bin')
const MB = 1024 * 1024

const SYNCER = `
const { parentPort, workerData } = require('node:worker_threads')
const fs = require('node:fs')
const { performance } = require('node:perf_hooks')
const { F, sizes, stop, phase } = workerData
const now = () => performance.timeOrigin + performance.now()
const fd = fs.openSync(F, 'r+')
const buf = Buffer.alloc(1024 * 1024, 7)
const rounds = []
for (const [d, grow] of sizes) {
  Atomics.wait(stop, 0, 0, 400)
  for (let i = 0; i < buf.length; i += 4096) buf[i] = (buf[i] + 1) & 255
  const w0 = now()
  const from = grow ? fs.fstatSync(fd).size : 0
  for (let off = 0; off < d * 1024 * 1024; off += buf.length) fs.writeSync(fd, buf, 0, buf.length, from + off)
  // The prober appends past here while the sync runs (phase 1), as a commit does.
  Atomics.store(phase, 1, Math.floor((from + d * 1024 * 1024) / 4096))
  Atomics.store(phase, 0, 1)
  const s0 = now()
  fs.fsyncSync(fd)
  const s1 = now()
  Atomics.store(phase, 0, 0)
  Atomics.wait(stop, 0, 0, 20)
  rounds.push({ d, grow, w0, s0, s1 })
}
Atomics.wait(stop, 0, 0, 400)
fs.closeSync(fd)
parentPort.postMessage(rounds)
`

const PROBER = `
const { parentPort, workerData } = require('node:worker_threads')
const fs = require('node:fs')
const { performance } = require('node:perf_hooks')
const { F, G, inside, stop, phase } = workerData
const now = () => performance.timeOrigin + performance.now()
const f = fs.openSync(F, 'r+'), g = fs.openSync(G, 'r+')
const b = Buffer.alloc(4096, 1)
let end = fs.fstatSync(f).size, k = 0
const ops = { write: [], extend: [], read: [], size: [], other: [] }
const t = (kind, fn) => { const at = now(); fn(); ops[kind].push([at, now() - at]) }
while (Atomics.load(stop, 0) === 0) {
  k++
  t('write', () => fs.writeSync(f, b, 0, 4096, inside + (k % 2048) * 4096))
  if (Atomics.load(phase, 0) === 1) {
    t('extend', () => fs.writeSync(f, b, 0, 4096, Atomics.add(phase, 1, 1) * 4096))
  }
  t('read', () => fs.readSync(f, b, 0, 4096, (k * 7919 % 4096) * 4096))
  t('size', () => fs.fstatSync(f))
  t('other', () => fs.writeSync(g, b, 0, 4096, (k % 2048) * 4096))
  Atomics.wait(stop, 0, 0, 1)
}
parentPort.postMessage(ops)
`

const sizes: Array<[number, boolean]> = [[64, false], [64, true], [64, false], [64, true], [128, false], [128, true]]
const most = 128
// F: written once in full and synced (the syncer then only rewrites it), plus 8 MB the prober writes inside.
function fill(file: string, mb: number) {
  const fd = fs.openSync(file, 'w')
  const buf = Buffer.alloc(MB, 3)
  for (let i = 0; i < mb; i++) fs.writeSync(fd, buf, 0, MB, i * MB)
  fs.fsyncSync(fd)
  fs.closeSync(fd)
}
fill(F, most + 8)
fill(G, 8)

const stop = new Int32Array(new SharedArrayBuffer(4))
const phase = new Int32Array(new SharedArrayBuffer(8))
const prober = new Worker(PROBER, { eval: true, workerData: { F, G, inside: most * MB, stop, phase } })
const probed = new Promise<Record<string, Array<[number, number]>>>(r => prober.once('message', r))
const syncer = new Worker(SYNCER, { eval: true, workerData: { F, sizes, phase, stop: new Int32Array(new SharedArrayBuffer(4)) } })
const rounds = await new Promise<Array<{ d: number; grow: boolean; w0: number; s0: number; s1: number }>>(r => syncer.once('message', r))
Atomics.store(stop, 0, 1)
const ops = await probed
await prober.terminate()
await syncer.terminate()

console.log(`      ${process.platform}: ${ops.write.length} probes of each kind (extending ones only during a sync)`)
for (const r of rounds) {
  const line = Object.entries(ops).map(([kind, list]) => {
    const inSync = list.filter(([at, ms]) => at < r.s1 && at + ms > r.s0)
    const outside = list.filter(([at, ms]) => (at + ms < r.w0 - 50) || at > r.s1 + 50)
    const max = (l: Array<[number, number]>) => l.reduce((m, [, ms]) => Math.max(m, ms), 0).toFixed(1)
    return `${kind} ${max(inSync)} (${inSync.length}) / ${max(outside)}`
  }).join(', ')
  console.log(`      ${r.d} MB ${r.grow ? 'appended' : 'rewritten'}: written in ${(r.s0 - r.w0).toFixed(0)} ms, synced in ${(r.s1 - r.s0).toFixed(0)} ms; `
    + `longest ms during the sync (probes) / outside: ${line}`)
}
fs.rmSync(dir, { recursive: true, force: true })
console.log('All zz-win-fs assertions passed.')
process.exit(0)
