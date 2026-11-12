// Over 200 lines: one setup (a sheet, a filler writer, the probe) and the seven ways a write meets the checkpoint
// worker's start-over write, read together.
// A transform_column call's writes on the API thread take turns with the checkpoint worker's write that starts
// the WAL over (lib/wal-turn.ts, wal-checkpoint-worker.ts): no page waits for that write, or starts the WAL over
// itself (which syncs the WAL's new header inside its commit, on the event loop). Held inside that write with the
// write lock taken (a tests-only hold), the worker keeps a page from beginning, the event loop free, until it is
// done; one starting between a page's read of the WAL and its BEGIN finds the page's turn and skips, so the page
// never waits for the lock. A start-over the worker skipped (another connection held the write lock, or a page
// its turn) is asked for again by the next page; one copied between a page's read of the WAL and its BEGIN (a
// checkpoint on another connection, in a tests-only hook there) ends that transaction unwritten, then the page
// asks; an empty WAL (its first write writes and syncs the header) is begun by the worker too. A worker whose
// connection can't write (query_only, a tests-only switch) skips quietly, its checkpoint's numbers unchanged, and
// the page goes on. Each case reads the WAL itself, per transaction (sqlite-write-probe.ts), never a disk's speed,
// save the bounds on the loop and on a transaction's wait for the lock.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import transformMod from '../../server/src/services/column-transform'
import walMod from '../../server/src/lib/wal-checkpointer'
import sharedMod from '../../server/src/lib/wal-shared'
import turnMod from '../../server/src/lib/wal-turn'
import { sqliteWriteProbe, transactionLine } from './sqlite-write-probe'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { transformColumn } = transformMod as typeof import('../../server/src/services/column-transform')
const { checkpointAsked, checkpointInBackground, closeWalCheckpointer, takeWalCheckpointerStats, walCheckpointerIdle,
  walState } = walMod as typeof import('../../server/src/lib/wal-checkpointer')
const { FREE, PAGE, TURN, endStartOverHoldForTests, holdStartOverForTests, startOverHeldForTests,
  startOverReadOnlyForTests, walShared } = sharedMod as typeof import('../../server/src/lib/wal-shared')
const { closeWalTurnReader, setBeforeTurnWriteForTests, takeWalTurnStats } =
  turnMod as typeof import('../../server/src/lib/wal-turn')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}
// What reaches stderr, the worker thread's console.error included (Node writes a worker's output to it).
const logged: string[] = []
const toStderr = process.stderr.write.bind(process.stderr) as (chunk: unknown, ...rest: unknown[]) => boolean
process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
  logged.push(String(chunk))
  return toStderr(chunk, ...rest)
}) as typeof process.stderr.write
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

// One page of rows (TRANSFORM_PAGE_ROWS is 250); each case writes its own target column, already listed.
const ROWS = 200
const uid = uuid(), tid = uuid(), sid = uuid(), filler = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
const addSheet = db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,?,?)')
addSheet.run(sid, tid, uid, 'S', 0, JSON.stringify(['N', 'A', 'B', 'C', 'D', 'E', 'F', 'G']))
addSheet.run(filler, tid, uid, 'Filler', 1, JSON.stringify(['N']))
const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
db.transaction(() => {
  for (let i = 0; i < ROWS; i++) insert.run(uuid(), sid, uid, i, JSON.stringify({ N: `r${i}` }))
}).immediate()
let next = 0
// Frames for the worker to copy: `count` rows in one transaction on the API connection, before the call.
const fill = db.transaction((count: number) => {
  for (let i = 0; i < count; i++, next++) {
    insert.run(uuid(), filler, uid, next, JSON.stringify({ N: 'n'.repeat(400) }))
  }
})
const probe = sqliteWriteProbe(db, process.env.DB_PATH!, checkpointAsked)
const other = () => new Database(process.env.DB_PATH!)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const call = (target: string) =>
  transformColumn(uid, { sheetId: sid, operation: 'template', template: '{{N}}!', targetColumn: target })

// A fresh window: the WAL holds `rows` rows' frames, none copied; the numbers zeroed.
async function fresh(rows: number) {
  await walCheckpointerIdle()
  probe.reset()
  if (rows > 0) fill.immediate(rows)
  takeWalCheckpointerStats()
  takeWalTurnStats()
  logged.length = 0
}
// The call's numbers, and the transactions on the API connection that started the WAL over, printed.
function after(label: string, since: number) {
  const records = probe.records().filter(r => r.at >= since)
  const startedOver = records.filter(r => r.startedOver).map(transactionLine)
  const k = takeWalCheckpointerStats()
  const t = takeWalTurnStats()
  console.log(`      ${label}: ${JSON.stringify({ restarts: k.restarts, ...t })}; transactions:`)
  for (const r of records) console.log(`        ${transactionLine(r)}`)
  return { records, startedOver, k, t }
}
const allCopied = () => { const s = walState(); return s !== null && s.log > 0 && s.checkpointed === s.log }

async function main() {
  await check('the worker held in its start-over write, the write lock taken: a page asked to begin then waits '
    + 'for it with the event loop free, and begins only once it is done', async () => {
    await fresh(200)
    holdStartOverForTests(1500)
    let releasedAt = Infinity
    let loopMax = 0
    try {
      const asked = checkpointInBackground()
      for (const t0 = Date.now(); !startOverHeldForTests(); await sleep(2)) {
        assert.ok(Date.now() - t0 < 5000, 'the worker never held its write')
      }
      // Ended from this thread 300 ms on: a page waiting for the lock here would hold the loop past it.
      const release = setTimeout(() => { releasedAt = performance.now(); endStartOverHoldForTests() }, 300)
      let last = performance.now()
      const sampler = setInterval(() => { const now = performance.now(); loopMax = Math.max(loopMax, now - last)
        last = now }, 5)
      const since = performance.now()
      try {
        const out = await call('A')
        assert.ok('ok' in out && out.ok.updated === ROWS, JSON.stringify(out))
      } finally { clearInterval(sampler); clearTimeout(release) }
      await asked
      const { records, startedOver, t } = after('held', since)
      assert.ok(records.length > 0)
      const ms = (at: number) => Math.round(at - since)
      const done = releasedAt === Infinity ? 'its end never ran here before the call answered' : `${ms(releasedAt)} ms`
      assert.ok(records.every(r => r.at >= releasedAt), `a transaction began before the worker was done `
        + `(${done}): ${transactionLine(records[0])} at ${ms(records[0].at)} ms`)
      assert.ok(loopMax < 150, `the event loop was held ${Math.round(loopMax)} ms`)
      assert.ok(t.turnWaits >= 1, 'the page found the worker\'s turn')
      assert.deepEqual(startedOver, [])
    } finally { holdStartOverForTests(0); endStartOverHoldForTests() }
  })

  await check('the worker starting its write between a page\'s read of the WAL and its BEGIN: it finds the page\'s '
    + 'turn and skips it, so the page never waits for the write lock; the page then asks for it', async () => {
    await fresh(200)
    holdStartOverForTests(1000)
    const spin = new Int32Array(new SharedArrayBuffer(4))
    let asked: Promise<unknown> | undefined
    setBeforeTurnWriteForTests(() => {
      setBeforeTurnWriteForTests(null)
      asked = checkpointInBackground()
      // Until the worker holds its write, or copied every frame and had time to try it. Only that hold.
      for (let t0 = Date.now(), copied = 0; Date.now() - t0 < 3000 && !startOverHeldForTests();) {
        if (allCopied()) { copied ||= Date.now(); if (Date.now() - copied > 50) break }
        Atomics.wait(spin, 0, 0, 1)
      }
      holdStartOverForTests(0)
    })
    const since = performance.now()
    try {
      const out = await call('G')
      assert.ok('ok' in out && out.ok.updated === ROWS, JSON.stringify(out))
    } finally { setBeforeTurnWriteForTests(null); holdStartOverForTests(0); endStartOverHoldForTests() }
    await asked
    const { records, startedOver, k, t } = after('worker between read and BEGIN', since)
    assert.deepEqual(records.filter(r => r.ms > 100).map(transactionLine), [], 'transactions that waited for the lock')
    assert.deepEqual(startedOver, [], 'transactions that started the WAL over on this thread')
    assert.ok(t.asks >= 1 && k.restarts === 1, JSON.stringify({ ...t, restarts: k.restarts }))
  })

  await check('the worker\'s start-over skipped, another connection holding the write lock: the next page asks the '
    + 'worker to start the WAL over, and no transaction on the API connection starts it over', async () => {
    await fresh(200)
    const holder = other()
    holder.prepare('BEGIN IMMEDIATE').run()
    try { await checkpointInBackground() } finally { holder.prepare('ROLLBACK').run(); holder.close() }
    assert.ok(allCopied(), `the WAL: ${JSON.stringify(walState())}`)
    takeWalCheckpointerStats()
    const since = performance.now()
    const out = await call('B')
    assert.ok('ok' in out && out.ok.updated === ROWS, JSON.stringify(out))
    const { startedOver, k, t } = after('lock held', since)
    assert.deepEqual(startedOver, [], 'transactions that started the WAL over on this thread')
    assert.ok(t.asks >= 1 && k.restarts === 1, JSON.stringify({ ...t, restarts: k.restarts }))
  })

  await check('the worker\'s start-over skipped, a page holding its turn: the worker doesn\'t try it, and the next '
    + 'page asks for it; no transaction on the API connection starts the WAL over', async () => {
    await fresh(200)
    assert.equal(Atomics.compareExchange(walShared, TURN, FREE, PAGE), FREE)
    let skipped
    try { skipped = await checkpointInBackground() } finally { Atomics.compareExchange(walShared, TURN, PAGE, FREE) }
    assert.ok(allCopied(), `the WAL: ${JSON.stringify(walState())}, the checkpoint: ${JSON.stringify(skipped)}`)
    assert.equal(skipped?.startOver, 'turn')
    takeWalCheckpointerStats()
    const since = performance.now()
    const out = await call('C')
    assert.ok('ok' in out && out.ok.updated === ROWS, JSON.stringify(out))
    const { startedOver, k, t } = after('turn held', since)
    assert.deepEqual(startedOver, [], 'transactions that started the WAL over on this thread')
    assert.ok(t.asks >= 1 && k.restarts === 1, JSON.stringify({ ...t, restarts: k.restarts }))
  })

  await check('every frame copied between a page\'s read of the WAL and its BEGIN: its transaction ends unwritten '
    + 'and it asks the worker, so no transaction on the API connection starts the WAL over', async () => {
    await fresh(200)
    const conn = other()
    setBeforeTurnWriteForTests(() => { setBeforeTurnWriteForTests(null); conn.pragma('wal_checkpoint(PASSIVE)') })
    const since = performance.now()
    try {
      const out = await call('D')
      assert.ok('ok' in out && out.ok.updated === ROWS, JSON.stringify(out))
    } finally { setBeforeTurnWriteForTests(null); conn.close() }
    const { startedOver, k, t } = after('copied before BEGIN', since)
    assert.deepEqual(startedOver, [], 'transactions that started the WAL over on this thread')
    assert.ok(t.caughtInside === 1 && k.restarts === 1, JSON.stringify({ ...t, restarts: k.restarts }))
  })

  await check('an empty WAL (its first write writes and syncs its header): the page asks the worker to begin it, '
    + 'and no transaction on the API connection does', async () => {
    await fresh(0)
    db.pragma('wal_checkpoint(TRUNCATE)')
    assert.deepEqual(walState(), { log: 0, checkpointed: 0 })
    const since = performance.now()
    const out = await call('E')
    assert.ok('ok' in out && out.ok.updated === ROWS, JSON.stringify(out))
    const { startedOver, k, t } = after('empty WAL', since)
    assert.deepEqual(startedOver, [], 'transactions that began the WAL on this thread')
    assert.ok(t.asks >= 1 && k.restarts === 1, JSON.stringify({ ...t, restarts: k.restarts }))
  })

  await check('the worker\'s connection can\'t write: its start-over is skipped quietly, the checkpoint\'s numbers '
    + 'as SQLite gave them; a page then goes on', async () => {
    await fresh(200)
    const before = walState()!
    startOverReadOnlyForTests(true)
    try {
      const r = await checkpointInBackground()
      // The worker's output comes over its own channel, after its answer or before: given time to arrive.
      await sleep(500)
      assert.deepEqual(logged, [], 'nothing logged')
      assert.ok(r && !r.busy && r.log >= before.log && r.checkpointed === r.log, JSON.stringify(r))
      assert.equal(r.startOver, 'read-only')
      assert.ok(allCopied(), 'the WAL left as it was')
      const t0 = performance.now()
      const out = await call('F')
      const ms = performance.now() - t0
      assert.ok('ok' in out && out.ok.updated === ROWS && out.ok.next_cursor === undefined, JSON.stringify(out))
      assert.ok(ms < 1000, `the page waited ${Math.round(ms)} ms`)
      assert.deepEqual(logged, [], 'nothing logged')
      after('read-only', t0)
    } finally { startOverReadOnlyForTests(false) }
  })
  await closeWalCheckpointer()
  closeWalTurnReader()
}

main()
  .catch(e => { failures++; console.log('FAIL threw', e) })
  .finally(() => {
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
    console.log('All wal-turn assertions passed.')
    process.exit(0)
  })
