// Experiment (not for merge): where the time goes in a bulk slice that runs while the checkpoint worker copies the
// WAL back. run-clear-big's two cases at 50,000 rows, 3 times each, with: every transaction's time split into its
// statements (reads, and pages spilled) and the rest (BEGIN and the commit, which writes the WAL); the worker's
// copy started (set before its WAL sync), ended (after its database sync) and the WAL started over, read from the
// WAL index by a watcher thread; that thread's own size queries and reads of the database and WAL files, any that
// took 5 ms or more; garbage collection pauses.
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { performance, PerformanceObserver } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
import { loopWatch } from './bulk-wal-kit'
import { sqliteWriteProbe, transactionLine } from './sqlite-write-probe'
const { db, uid, ok, done, idle, sheet } = undoKit('zz-win-clear')
const { seedProcessingPlaceholders, PLACEHOLDER } = await import('../../server/src/lib/placeholder-cells')
const { startFormulaColumn } = await import('../../server/src/services/formula-column')
const { cancelRun } = await import('../../server/src/services/run-lifecycle')
const { stopSheetRuns } = await import('../../server/src/services/sheet-runs-stop')
const { checkpointAsked, closeWalCheckpointer, walCheckpointerIdle } =
  await import('../../server/src/lib/wal-checkpointer')
console.error = () => {}
const dbPath = process.env.DB_PATH!
const probe = sqliteWriteProbe(db, dbPath, checkpointAsked)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Statement time inside each outermost transaction.
type Tx = { at: number; ms: number; stmtMs: number; n: number; slow: { sql: string; ms: number } }
let acc = { ms: 0, n: 0, slow: { sql: '', ms: 0 } }
let txs: Tx[] = []
const d = db as any
const prepare = d.prepare.bind(db)
d.prepare = (sql: string) => {
  const st = prepare(sql)
  for (const m of ['run', 'get', 'all']) {
    const f = st[m].bind(st)
    st[m] = (...a: unknown[]) => {
      const t = performance.now()
      try { return f(...a) } finally {
        const ms = performance.now() - t
        acc.ms += ms; acc.n++
        if (ms > acc.slow.ms) acc.slow = { sql: sql.replace(/\s+/g, ' ').trim().slice(0, 60), ms }
      }
    }
  }
  return st
}
const transaction = d.transaction.bind(db)
d.transaction = (fn: (...a: unknown[]) => unknown) => {
  const t = transaction(fn)
  const timed = (call: (...a: unknown[]) => unknown) => (...a: unknown[]) => {
    if (db.inTransaction) return call(...a)
    acc = { ms: 0, n: 0, slow: { sql: '', ms: 0 } }
    const at = performance.now()
    try { return call(...a) } finally { txs.push({ at, ms: performance.now() - at, stmtMs: acc.ms, n: acc.n, slow: acc.slow }) }
  }
  const w = timed(t) as any
  for (const k of ['default', 'deferred', 'immediate', 'exclusive']) w[k] = timed(t[k])
  return w
}

const WATCHER = `
const { parentPort, workerData } = require('node:worker_threads')
const fs = require('node:fs')
const { performance } = require('node:perf_hooks')
const { dbPath, stop } = workerData
const now = () => performance.timeOrigin + performance.now()
const shm = fs.openSync(dbPath + '-shm', 'r'), file = fs.openSync(dbPath, 'r'), wal = fs.openSync(dbPath + '-wal', 'r')
const head = Buffer.alloc(4), page = Buffer.alloc(4096)
const u32 = at => { try { return fs.readSync(shm, head, 0, 4, at) === 4 ? head.readUInt32LE(0) : -1 } catch { return -2 } }
const events = [], slow = []
const timed = (what, f) => { const at = now(); f(); const ms = now() - at; if (ms >= 5) slow.push({ at, what, ms }) }
let was = {}, k = 0
while (Atomics.load(stop, 0) === 0) {
  k++
  const is = { frames: u32(16), copied: u32(96), copying: u32(128) }
  timed('db size', () => fs.fstatSync(file))
  timed('db read', () => fs.readSync(file, page, 0, 4096, 4096 * (k % 64)))
  timed('wal size', () => fs.fstatSync(wal))
  timed('wal read', () => fs.readSync(wal, page, 0, 4096, 32 + 4120 * (k % 64)))
  const at = now()
  const moved = key => was[key] !== undefined && is[key] !== was[key]
  if (moved('copying')) events.push({ at, what: 'copy to ' + is.copying + ' started (WAL ' + is.frames + ')' })
  if (moved('copied')) events.push({ at, what: 'copy to ' + is.copied + ' ended (WAL ' + is.frames + ')' })
  if (was.frames !== undefined && is.frames < was.frames) events.push({ at, what: 'WAL started over' })
  was = is
  Atomics.wait(stop, 0, 0, 1)
}
parentPort.postMessage({ events, slow })
`
type Seen = { events: Array<{ at: number; what: string }>; slow: Array<{ at: number; what: string; ms: number }> }
function watcher() {
  const stop = new Int32Array(new SharedArrayBuffer(4))
  const w = new Worker(WATCHER, { eval: true, workerData: { dbPath, stop } })
  const answer = new Promise<Seen | null>(r => { w.once('message', r); w.once('error', () => r(null)) })
  const gcs: Array<{ at: number; ms: number }> = []
  const gc = new PerformanceObserver(list => {
    for (const e of list.getEntries()) if (e.duration >= 10) gcs.push({ at: e.startTime, ms: e.duration })
  })
  gc.observe({ entryTypes: ['gc'] })
  return async () => {
    Atomics.store(stop, 0, 1)
    const seen = await answer
    await w.terminate()
    gc.disconnect()
    return { seen, gcs }
  }
}

const N = 50_000
const READERS = 20
const work = db.prepare('SELECT COUNT(*) FROM http_runs WHERE sheet_id = ? AND placeholder_work IS NOT NULL').pluck()
const held = db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ? AND instr(data, ?) > 0').pluck()

function addRows(sid: string, at: (i: number) => number, cells: (i: number) => object) {
  const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  db.transaction(() => { for (let i = 1; i < N; i++) ins.run(uuid(), sid, uid, at(i), JSON.stringify(cells(i))) })
    .immediate()
}
async function running(sid: string, column: string): Promise<string> {
  const id = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,'{}','running',?)`).run(id, sid, uid, column)
  await seedProcessingPlaceholders({ run: { kind: 'http', id }, sheetId: sid, userId: uid, columns: [column],
    targets: null, lastRow: N - 1, live: () => true })
  return id
}
async function watched(label: string, sid: string, stop: () => Promise<unknown>) {
  await walCheckpointerIdle()
  probe.reset()
  txs = []
  const end = watcher()
  await sleep(20)
  const watch = loopWatch(probe.records)
  const t0 = performance.now()
  await stop()
  while ((work.get(sid) as number) > 0) await sleep(5)
  const ms = performance.now() - t0
  const { longest } = watch()
  await sleep(30)
  const { seen, gcs } = await end()
  const rel = (t: number) => `+${(t - t0).toFixed(0)}`
  const abs = (t: number) => rel(t - performance.timeOrigin)
  const records = probe.records()
  console.log(`      ${label}: ${(ms / 1000).toFixed(1)} s, loop held at most ${longest.ms.toFixed(0)} ms at `
    + `${rel(longest.at)}, ${records.length} transactions`)
  console.log(`        worker: ${seen ? seen.events.map(e => `${e.what} ${abs(e.at)}`).join(', ') || 'nothing' : 'no watcher'}`)
  // The worker's copies, from the WAL index: each from its start to its end (or the next start).
  const ev = (seen?.events ?? []).map(e => ({ ...e, at: e.at - performance.timeOrigin }))
  const copies: Array<{ to: string; from: number; until: number }> = []
  for (const e of ev) {
    if (e.what === 'WAL started over') { for (const c of copies) if (c.until === Infinity) c.until = e.at; continue }
    const m = /^copy to (\d+) (started|ended)/.exec(e.what)
    if (!m || m[1] === '0') continue
    if (m[2] === 'started') copies.push({ to: m[1], from: e.at, until: Infinity })
    else { const c = copies.find(x => x.to === m[1] && x.until === Infinity); if (c) c.until = e.at }
  }
  console.log(`        copies: ${copies.map(c => `${c.to} ${rel(c.from)} for ${Number.isFinite(c.until)
    ? (c.until - c.from).toFixed(0) : '?'} ms`).join(', ') || 'none'}`)
  const during = (t: Tx) => copies.filter(c => t.at < c.until && t.at + t.ms > c.from)
    .map(c => `during copy to ${c.to} (${(t.at - c.from).toFixed(0)} ms in)`).join(', ')
  const sorted = [...txs].sort((a, b) => b.ms - a.ms)
  const slowTx = sorted.filter((t, i) => i < 3 || t.ms >= 55)
  for (const t of slowTx) {
    const r = records.find(x => Math.abs(x.at - t.at) < 0.5)
    console.log(`        tx ${rel(t.at)}: ${t.ms.toFixed(1)} ms, statements ${t.stmtMs.toFixed(1)} ms (${t.n}; slowest `
      + `${t.slow.ms.toFixed(1)} ms ${t.slow.sql.slice(0, 30)}), rest ${(t.ms - t.stmtMs).toFixed(1)} ms; `
      + `${r ? transactionLine(r) : ''} ${during(t)}`)
  }
  const stalls = (seen?.slow ?? []).sort((a, b) => b.ms - a.ms).slice(0, 10)
  console.log(`        watcher's calls of 5 ms or more: ${stalls.map(s => `${s.what} ${s.ms.toFixed(0)} ms ${abs(s.at)}`).join(', ') || 'none'}`)
  console.log(`        gc of 10 ms or more: ${gcs.map(g => `${g.ms.toFixed(0)} ms ${rel(g.at)}`).join(', ') || 'none'}`)
  // Every transaction that began while a checkpoint was asked, against the others: count, longest, frames.
  const asked = records.filter(r => r.checkpointing), not = records.filter(r => !r.checkpointing)
  const top = (l: typeof records) => l.reduce((m, r) => Math.max(m, r.ms), 0).toFixed(1)
  console.log(`        transactions with a checkpoint asked: ${asked.length} (longest ${top(asked)} ms); without: `
    + `${not.length} (longest ${top(not)} ms)`)
}

for (let rep = 1; rep <= 4; rep++) {
  await ok(`a first run, ${READERS} formulas reading it, cancelled at ${N} rows (${rep})`, async () => {
    const columns = Array.from({ length: READERS }, (_, k) => `F${k}`)
    const sid = sheet([{ Name: 'n0' }], ['Name', 'Answer'])
    for (const [k, column] of columns.entries()) {
      assert.ok('ok' in await startFormulaColumn(uid, sid, { column, formula: `{{Answer}} + "-${k}"` }), column)
      await idle(sid)
    }
    addRows(sid, i => i, i => ({ Name: `n${i}`, ...Object.fromEntries(columns.map((c, k) => [c, `-${k}`])) }))
    db.prepare(`UPDATE autorun_columns SET watermark_row_index = ? WHERE sheet_id = ?`).run(N - 1, sid)
    const id = await running(sid, 'Answer')
    await watched(`first ${rep}`, sid, () => cancelRun('http', id, uid))
    assert.equal(held.get(sid, PLACEHOLDER), 0, 'every ⏳ cleared')
  })
  await ok(`Stop all of 4 runs on a sorted sheet of ${N} rows (${rep})`, async () => {
    const columns = ['A', 'B', 'C', 'D']
    const sid = sheet([{ Name: 'n0' }], ['Name', ...columns])
    addRows(sid, i => (i * 7_919) % N, i => ({ Name: `n${i}` }))
    for (const c of columns) await running(sid, c)
    await watched(`stop all ${rep}`, sid, () => stopSheetRuns(uid, sid))
    assert.equal(held.get(sid, PLACEHOLDER), 0, 'every ⏳ cleared')
  })
}
console.log(`      db ${(fs.statSync(dbPath).size / 1024 / 1024).toFixed(0)} MB`)

await closeWalCheckpointer()
done()
