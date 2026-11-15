// What held the event loop, for a test that found it held: every SQLite call on `db` from now on taking at least
// SLOW_MS (its prepare, its run/get/all, db.pragma and db.exec), the garbage collector's pauses as long, and a
// watcher thread that reads the WAL index (the -shm file) every 2 ms: when the checkpoint worker's copy started
// (nBackfillAttempted) and ended (nBackfill, set after both its disk syncs), and when the WAL started over, seen
// apart from this thread. The watcher also times its own reads of the database file (its size, its first page), to
// show whether the file itself waited meanwhile. Times are performance.now() on this thread.
import fs from 'node:fs'
import { performance, PerformanceObserver } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'
import type Database from 'better-sqlite3'

const SLOW_MS = 40
type Took = { what: string; at: number; ms: number }

const WATCHER = `
const { parentPort, workerData } = require('node:worker_threads')
const fs = require('node:fs')
const { performance } = require('node:perf_hooks')
const { dbPath, stop } = workerData
const now = () => performance.timeOrigin + performance.now()
const shm = fs.openSync(dbPath + '-shm', 'r'), file = fs.openSync(dbPath, 'r')
const head = Buffer.alloc(4), page = Buffer.alloc(4096)
const u32 = at => {
  try { return fs.readSync(shm, head, 0, 4, at) === 4 ? head.readUInt32LE(0) : -1 } catch { return -2 }
}
const events = [], most = { size: { at: 0, ms: 0 }, page: { at: 0, ms: 0 }, index: { at: 0, ms: 0 } }
const timed = (key, f) => {
  const at = now(); f(); const ms = now() - at
  if (ms > most[key].ms) most[key] = { at, ms }
}
let was = {}
while (Atomics.load(stop, 0) === 0) {
  const is = {}
  timed('index', () => { is.frames = u32(16); is.copied = u32(96); is.copying = u32(128) })
  timed('size', () => fs.fstatSync(file))
  timed('page', () => fs.readSync(file, page, 0, 4096, 0))
  const at = now()
  const moved = key => was[key] !== undefined && is[key] !== was[key]
  if (moved('copying')) events.push({ at, what: 'copy to ' + is.copying + ' started' })
  if (moved('copied')) events.push({ at, what: 'copy to ' + is.copied + ' ended' })
  if (was.frames !== undefined && is.frames < was.frames) events.push({ at, what: 'WAL started over' })
  was = is
  Atomics.wait(stop, 0, 0, 2)
}
parentPort.postMessage({ events, most })
`

export function stallWatch(db: Database.Database, dbPath: string) {
  const calls: Took[] = []
  const gcs: Took[] = []
  const timed = <T>(what: string, f: () => T): T => {
    const at = performance.now()
    try { return f() } finally {
      const ms = performance.now() - at
      if (ms >= SLOW_MS) calls.push({ what: what.replace(/\s+/g, ' ').trim().slice(0, 50), at, ms })
    }
  }
  const d = db as any
  const { prepare, pragma, exec } = d
  d.prepare = (text: string) => {
    const stmt = timed(`prepare ${text}`, () => prepare.call(db, text))
    for (const m of ['run', 'get', 'all']) {
      const f = stmt[m].bind(stmt)
      stmt[m] = (...a: unknown[]) => timed(`${m} ${text}`, () => f(...a))
    }
    return stmt
  }
  d.pragma = (text: string, o?: unknown) => timed(`pragma ${text}`, () => pragma.call(db, text, o))
  d.exec = (text: string) => timed(`exec ${text}`, () => exec.call(db, text))
  const gc = new PerformanceObserver(list => {
    for (const e of list.getEntries()) {
      if (e.duration >= SLOW_MS) gcs.push({ what: 'gc', at: e.startTime, ms: e.duration })
    }
  })
  gc.observe({ entryTypes: ['gc'] })
  const stop = new Int32Array(new SharedArrayBuffer(4))
  const watcher = fs.existsSync(`${dbPath}-shm`)
    ? new Worker(WATCHER, { eval: true, workerData: { dbPath, stop } }) : null
  watcher?.unref()
  const answer = watcher ? new Promise<any>(r => watcher.once('message', r)) : Promise.resolve(null)
  const here = (t: number) => t - performance.timeOrigin

  // The record, `from` on: the calls and pauses, then the watcher's WAL index events and its longest file calls.
  return async (from: number): Promise<string> => {
    d.prepare = prepare; d.pragma = pragma; d.exec = exec
    Atomics.store(stop, 0, 1)
    const seen = await answer
    await watcher?.terminate()
    await new Promise(r => setImmediate(r))
    gc.disconnect()
    const ms = (t: number) => (t - from).toFixed(0)
    const took = [...calls, ...gcs].sort((a, b) => b.ms - a.ms).slice(0, 6)
      .map(c => `${c.what} ${c.ms.toFixed(0)} ms at ${ms(c.at)}`).join(' | ') || 'none'
    if (!seen) return `slow calls: ${took}; no watcher (no -shm file)`
    const events = seen.events.map((e: { at: number; what: string }) => `${e.what} ${ms(here(e.at))}`).join(', ')
    const most = Object.entries(seen.most as Record<string, { at: number; ms: number }>)
      .map(([k, v]) => `${k} ${v.ms.toFixed(0)} ms at ${ms(here(v.at))}`).join(', ')
    return `slow calls: ${took}; the WAL index: ${events || 'no change'}; the watcher's longest reads: ${most}`
  }
}
