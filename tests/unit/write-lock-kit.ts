// A rival connection to the test's database, for the tests that pin "a
// transaction that reads before it writes is IMMEDIATE" (write-lock-*.test.ts).
// The rival lives in a worker thread, as Cubex's run workers and lookup worker
// do, and writes right after a chosen read on this thread's connection
// (lib/db.ts), so the race SQLite fails a DEFERRED transaction on happens on
// every run, not now and then:
//   commit (the default): the rival writes and commits between the
//     transaction's first read and its first write. A deferred transaction's
//     write then fails with SQLITE_BUSY_SNAPSHOT. An immediate one holds the
//     write lock from its start: the rival waits for it ('blocked').
//   hold: the rival takes the write lock and keeps it `hold` ms. A deferred
//     transaction that read meanwhile fails its first write with SQLITE_BUSY
//     (busy_timeout never applies to it); an immediate one waits its turn.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import busyMod from '../../server/src/lib/sheet-busy'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { sheetBusyWith } = busyMod as typeof import('../../server/src/lib/sheet-busy')

const SENT = 0, BLOCKED = 1, LOCKED = 2, COMMITTED = 3
const ANSWER_MS = 10_000

const RIVAL = `
const { parentPort, workerData } = require('node:worker_threads')
const Database = require(workerData.driver)
const db = new Database(workerData.path)
const state = new Int32Array(workerData.state)
const tell = s => { Atomics.store(state, 0, s); Atomics.notify(state, 0) }
const insert = db.prepare('INSERT INTO rival_writes DEFAULT VALUES')
parentPort.on('message', hold => {
  db.pragma('busy_timeout = 0')
  try { db.exec('BEGIN IMMEDIATE') } catch (e) {
    if (e.code !== 'SQLITE_BUSY') throw e
    tell(${BLOCKED})
    db.pragma('busy_timeout = 10000')
    db.exec('BEGIN IMMEDIATE')
  }
  insert.run()
  if (Atomics.load(state, 0) !== ${BLOCKED}) tell(${LOCKED})
  if (hold > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, hold)
  db.exec('COMMIT')
  tell(${COMMITTED})
})
parentPort.postMessage('ready')
`

// raced: the rival wrote between the read and what followed. blocked: this
// thread's connection held the write lock, so the rival waited for it.
export interface Shot { outcome: 'unfired' | 'raced' | 'blocked'; at: number }
export interface Trigger { inTx: boolean; sql?: RegExp; hold?: number }

type Stmt = { source: string; database: unknown }
export async function rivalKit() {
  db.exec('CREATE TABLE IF NOT EXISTS rival_writes (id INTEGER PRIMARY KEY)')
  const state = new Int32Array(new SharedArrayBuffer(4))
  Atomics.store(state, 0, COMMITTED)
  const driver = createRequire(import.meta.url).resolve('better-sqlite3')
  const worker = new Worker(RIVAL, { eval: true, workerData: { path: db.name, driver, state: state.buffer } })
  await new Promise<void>((resolve, reject) => {
    worker.once('message', () => resolve())
    worker.once('error', reject)
  })
  let armed: { when: Trigger; shot: Shot } | null = null

  const fire = (hold: number): Shot['outcome'] => {
    Atomics.store(state, 0, SENT)
    worker.postMessage(hold)
    const until = Date.now() + ANSWER_MS
    for (;;) {
      const s = Atomics.load(state, 0)
      if (s === BLOCKED) return 'blocked'
      if (s >= (hold > 0 ? LOCKED : COMMITTED)) return 'raced'
      assert.ok(Date.now() < until, 'the rival connection never answered')
      Atomics.wait(state, 0, s, until - Date.now())
    }
  }
  // Every read on this thread's connection passes here once it has run.
  const after = (stmt: Stmt) => {
    const a = armed
    if (!a || stmt.database !== db || a.when.inTx !== db.inTransaction) return
    if (a.when.sql && !a.when.sql.test(stmt.source.trim())) return
    armed = null
    a.shot.outcome = fire(a.when.hold ?? 0)
    a.shot.at = Date.now()
  }
  const proto = Object.getPrototypeOf(db.prepare('SELECT 1')) as Record<'get' | 'all', (...a: unknown[]) => unknown>
  for (const name of ['get', 'all'] as const) {
    const plain = proto[name]
    proto[name] = function (this: Stmt, ...args: unknown[]) {
      const out = plain.apply(this, args)
      after(this)
      return out
    }
  }

  const writes = () => db.prepare('SELECT COUNT(*) FROM rival_writes').pluck().get() as number
  return {
    // The rival writes after the next read matching `when` (one shot).
    arm(when: Trigger): Shot {
      const shot: Shot = { outcome: 'unfired', at: 0 }
      armed = { when, shot }
      return shot
    },
    disarm() { armed = null },
    // Until the rival's last write is in (it may be waiting for this thread).
    async settled() {
      while (Atomics.load(state, 0) !== COMMITTED) await new Promise(r => setTimeout(r, 5))
    },
    writes,
    stop: () => worker.terminate(),
  }
}

// What a call returned, or the SQLite code (else the message) of what it threw.
export async function attempt<T>(fn: () => T | Promise<T>): Promise<{ value: T } | { threw: string }> {
  try { return { value: await fn() } }
  catch (e) { return { threw: (e as { code?: string }).code ?? (e as Error).message } }
}

// A throwaway database migrated, one account and table, sheets of rows, readers.
export function fixture(name: string) {
  if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
  runMigrations()
  console.warn = () => {}
  const uid = uuid(), tid = uuid()
  db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
  db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
  let failures = 0, position = 0
  const ok = async (label: string, fn: () => void | Promise<void>) => {
    try { await fn(); console.log('ok  ', label) }
    catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
  }
  const done = () => {
    console.log(failures === 0 ? `\n${name}: all passed` : `\n${name}: ${failures} FAILED`)
    process.exit(failures === 0 ? 0 : 1)
  }
  const sheet = (columns: string[], rows: Array<Record<string, string>>): string => {
    const id = uuid()
    db.prepare('INSERT INTO sheets (id, table_id, user_id, name, position, column_order) VALUES (?,?,?,?,?,?)')
      .run(id, tid, uid, `S${position}`, position++, JSON.stringify(columns))
    const ins = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
    rows.forEach((r, i) => ins.run(uuid(), id, uid, i, JSON.stringify(r)))
    return id
  }
  const cells = (s: string, c: string) => (db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index')
    .pluck().all(s) as string[]).map(d => JSON.parse(d)[c] ?? '')
  const order = (s: string) =>
    JSON.parse(db.prepare('SELECT column_order FROM sheets WHERE id = ?').pluck().get(s) as string) as string[]
  const idle = async (s: string) => { while (sheetBusyWith(s)) await new Promise(r => setTimeout(r, 5)) }
  return { db, uid, ok, done, sheet, cells, order, idle }
}
