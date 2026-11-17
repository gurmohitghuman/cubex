// On Windows no write in turn begins while the checkpoint worker's checkpoint runs (lib/wal-checkpointer.ts,
// lib/wal-turn.ts): there a commit that writes the WAL meanwhile waited inside it (58 to 110 ms where others took
// about 31, once over a second) while the WAL file grew, as after a server start. The switch is on here on every
// platform but where a case says otherwise, so Linux runs the Windows path too. The WAL is emptied first, as after a
// server start. Two bulk writers at once (lib/bulk-slices.ts), one ending while the other writes, so its last
// checkpoint comes mid-slice for the other: no slice begins while a checkpoint runs. A transform's pages
// (services/column-transform-pages.ts): none either. A slice that waits leaves the event loop free (timers run, no
// stretch over 50 ms). A checkpoint that never answers holds a writer no longer than the wait's limit, once; a
// worker that stops answers its waiters. One that outlasts the limit: the slice waiting before it begins goes on,
// but a wait at the pause has no limit, so the WAL stays bounded. Timing-free but the waits' limit and the worker
// stopping; the longest slice and stretch are printed.
// Off (Linux's default) a writer still asks part way and writes on while the worker copies.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import walMod from '../../server/src/lib/wal-checkpointer'
import bulkMod from '../../server/src/lib/bulk-slices'
import turnMod from '../../server/src/lib/wal-turn'
import transformMod from '../../server/src/services/column-transform'
import constMod from '../../server/src/lib/constants'
import { loopWatch } from './bulk-wal-kit'
import { sqliteWriteProbe, transactionLine, type TransactionRecord } from './sqlite-write-probe'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const w = walMod as typeof import('../../server/src/lib/wal-checkpointer')
const { asBulkWriter } = bulkMod as typeof import('../../server/src/lib/bulk-slices')
const { takeWalTurnStats } = turnMod as typeof import('../../server/src/lib/wal-turn')
const { transformColumn } = transformMod as typeof import('../../server/src/services/column-transform')
const { WAL_BULK_PAUSE_FRAMES } = constMod as typeof import('../../server/src/lib/constants')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
const logged: string[] = []
console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')) }
let failures = 0
async function ok(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
if (process.platform !== 'win32') w.setWritesWaitForCheckpointsForTests(true)
const probe = sqliteWriteProbe(db, process.env.DB_PATH!, w.checkpointAsked)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Rows of 3,000 random bytes, about a page each: a slice of 300 writes about 300 frames, as a big clear's does.
const ROWS = 24_000
const SLICE = 300
db.exec('CREATE TABLE waits_rows (id INTEGER PRIMARY KEY, b BLOB)')
db.transaction(() => {
  const add = db.prepare('INSERT INTO waits_rows (b) VALUES (randomblob(3000))')
  for (let i = 0; i < ROWS; i++) add.run()
}).immediate()
const rewrite = db.prepare('UPDATE waits_rows SET b = randomblob(3000) WHERE id BETWEEN ? AND ?')
// A bulk writer rewriting rows from..to, SLICE a slice.
const job = (from: number, to: number) => asBulkWriter(async bulk => {
  for (let at = from; at <= to; at += SLICE) await bulk.slice(() => rewrite.run(at, Math.min(to, at + SLICE - 1)))
})

// `work` from a WAL emptied first, measured: the transactions that began while a checkpoint ran, printed.
async function measured(label: string, work: () => Promise<unknown>) {
  await w.walCheckpointerIdle()
  probe.reset()
  w.takeWalCheckpointerStats()
  takeWalTurnStats()
  const t0 = performance.now()
  const watch = loopWatch(probe.records)
  await work()
  const { longest } = watch()
  const ms = performance.now() - t0
  const records = probe.records()
  const during = records.filter(r => r.checkpointing)
  const top = (l: TransactionRecord[]) => l.reduce((m, r) => Math.max(m, r.ms), 0).toFixed(0)
  const k = w.takeWalCheckpointerStats()
  console.log(`      ${label}: ${(ms / 1000).toFixed(1)} s, loop held at most ${longest.ms.toFixed(0)} ms, `
    + `${records.length} transactions (longest ${top(records)} ms), ${during.length} begun during a checkpoint `
    + `(longest ${top(during)} ms); worker: ${k.checkpoints} checkpoints, ${k.pauses} waits at the pause, `
    + `${JSON.stringify(takeWalTurnStats())}`)
  for (const r of during.slice(0, 5)) console.log(`        ${transactionLine(r)}`)
  return { records, during, loopMs: longest.ms, k }
}

await ok('two bulk writers at once, the WAL emptied first, one ending mid-way: no slice begins while a checkpoint '
  + 'runs', async () => {
  const m = await measured('two bulk writers', () => Promise.all([job(1, 20_000), job(20_001, ROWS)]))
  assert.equal(m.records.length, Math.ceil(20_000 / SLICE) + Math.ceil((ROWS - 20_000) / SLICE), 'slices')
  assert.deepEqual(m.during.map(transactionLine), [], 'slices begun while a checkpoint ran')
})

await ok('a transform\'s pages, the WAL emptied first: none begins while a checkpoint runs', async () => {
  const sid = uuid(), uid = uuid(), tid = uuid()
  db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
  db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
  db.prepare(`INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,'S',0,'["N"]')`)
    .run(sid, tid, uid)
  const add = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  // Cells of about 200 characters: the walk's pages take the WAL past its pause more than once.
  const cell = (i: number) => JSON.stringify({ N: `n${i}-${'x'.repeat(200)}` })
  db.transaction(() => { for (let i = 0; i < 20_000; i++) add.run(uuid(), sid, uid, i, cell(i)) }).immediate()
  const m = await measured('a transform', async () => {
    const out = await transformColumn(uid, { sheetId: sid, operation: 'template', template: '{{N}}!',
      targetColumn: 'M' })
    assert.ok('ok' in out, JSON.stringify(out))
  })
  assert.ok(m.k.pauses >= 1, `the walk never waited at its pause: ${JSON.stringify(m.k)}`)
  assert.deepEqual(m.during.map(transactionLine), [], 'pages begun while a checkpoint ran')
})

// One slice from a WAL with frames to copy, after a checkpoint asked that takes `holdMs` first: when it began, how
// long the loop's longest stretch was meanwhile and how many 5 ms timers ran.
async function sliceAfterHeldCheckpoint(holdMs: number, during?: () => void) {
  // The worker running first, so the request (and its hold) reaches it now.
  await w.walCheckpointerIdle()
  await w.checkpointInBackground()
  rewrite.run(1, 50)
  w.setCheckpointDelayForTests(holdMs)
  const asked = w.checkpointInBackground()
  w.setCheckpointDelayForTests(0)
  const t0 = performance.now()
  let ticks = 0
  const timer = setInterval(() => { ticks++ }, 5)
  const watch = loopWatch(() => [])
  let began = 0
  during?.()
  await asBulkWriter(bulk => bulk.slice(() => { began = performance.now() - t0; rewrite.run(51, 60) }))
  const { longest } = watch()
  clearInterval(timer)
  return { began, ticks, loopMs: longest.ms, asked }
}

await ok('a slice waiting for a checkpoint leaves the event loop free, and begins once it answered', async () => {
  takeWalTurnStats()
  const s = await sliceAfterHeldCheckpoint(800)
  console.log(`      began after ${s.began.toFixed(0)} ms; ${s.ticks} timers ran; loop held at most `
    + `${s.loopMs.toFixed(0)} ms`)
  assert.ok(s.began >= 750, `the slice began ${s.began.toFixed(0)} ms after the checkpoint was asked`)
  assert.ok(s.ticks >= 20 && s.loopMs < 50, `${s.ticks} timers ran, the loop held ${s.loopMs.toFixed(0)} ms`)
  assert.equal(takeWalTurnStats().checkpointWaits, 1, 'waits for a running checkpoint')
})

await ok('a checkpoint that never answers holds a writer no longer than the limit, once', async () => {
  w.setCheckpointWaitLimitForTests(300)
  try {
    const first = await sliceAfterHeldCheckpoint(3_000)
    const t0 = performance.now()
    await asBulkWriter(bulk => bulk.slice(() => rewrite.run(61, 70)))
    const second = performance.now() - t0
    console.log(`      the first slice began after ${first.began.toFixed(0)} ms, the second took `
      + `${second.toFixed(0)} ms`)
    assert.ok(first.began >= 250 && first.began < 2_000, `the first began after ${first.began.toFixed(0)} ms`)
    assert.ok(second < 250, `the second waited ${second.toFixed(0)} ms for the same checkpoint`)
    assert.equal(logged.filter(l => l.includes('gave no answer in 300 ms')).length, 1, logged.join('\n'))
    await first.asked
  } finally { w.setCheckpointWaitLimitForTests(null) }
})

await ok('a worker that stops while a slice waits: the slice goes on at once', async () => {
  const stop = () => { void sleep(200).then(() => w.stopCheckpointWorkerForTests()) }
  const s = await sliceAfterHeldCheckpoint(3_000, stop)
  console.log(`      began after ${s.began.toFixed(0)} ms`)
  assert.ok(s.began >= 150 && s.began < 1_500, `the slice began after ${s.began.toFixed(0)} ms`)
})

await ok('a checkpoint that outlasts the limit: a slice waiting before it begins goes on, and one at the pause '
  + 'waits it out, so the WAL stays under its bound', async () => {
  // Every checkpoint held 1 s, past a 300 ms limit: the job ending first asks one that the other's next slice gives
  // up on; at its pause the other waits however long (going on there would take the WAL past its bound).
  w.setCheckpointWaitLimitForTests(300)
  w.setCheckpointDelayForTests(1_000)
  const before = logged.length
  try {
    const m = await measured('slow checkpoints', () => Promise.all([job(1, 20_000), job(20_001, ROWS)]))
    const p = probe.read()
    assert.ok(logged.slice(before).some(l => l.includes('gave no answer in 300 ms')), 'no slice went on')
    assert.ok(p.mostWalFrames <= WAL_BULK_PAUSE_FRAMES + 2 * p.mostTransactionFrames,
      `the WAL held ${p.mostWalFrames} frames, past ${WAL_BULK_PAUSE_FRAMES} and two slices`)
    assert.ok(m.k.pauses > 0 && m.k.pausedMs > 300, `no pause outlasted the limit: ${JSON.stringify(m.k)}`)
  } finally { w.setCheckpointDelayForTests(0); w.setCheckpointWaitLimitForTests(null) }
})

await ok('the platform\'s own: on Windows only; off, a writer asks part way and writes on during the copy',
  async () => {
    w.setWritesWaitForCheckpointsForTests(null)
    assert.equal(w.writesWaitForCheckpoints(), process.platform === 'win32')
    w.setWritesWaitForCheckpointsForTests(false)
    // Each checkpoint held 300 ms first, as on a slow disk: the slices after the ask come before its answer.
    w.setCheckpointDelayForTests(300)
    try {
      const m = await measured('switched off', () => job(1, 9_000))
      assert.ok(m.during.length > 0, 'no slice was written while a checkpoint ran')
    } finally { w.setCheckpointDelayForTests(0) }
  })

await w.closeWalCheckpointer()
if (failures > 0) { console.log(`${failures} wal-checkpoint-waits assertion(s) failed`); process.exit(1) }
console.log('All wal-checkpoint-waits assertions passed.')
process.exit(0)
