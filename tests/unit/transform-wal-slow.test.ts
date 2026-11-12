// transform_column on a slow disk (services/column-transform-pages.ts,
// lib/wal-checkpointer.ts): each checkpoint on the worker takes over a second,
// as a disk sync might, so the worker falls behind the pages. The walk waits
// for it between pages, never on the event loop: the loop is never held 200 ms,
// no checkpoint runs on the API connection (only SQLite's NOOP, which reads the
// WAL's size), the WAL never holds more than WAL_PAUSE_FRAMES and one page, and
// every row is written exactly once. With no worker (its file can't load), the
// checkpoints run on the API thread, as before; closed, a later use starts a
// new worker.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import transformMod from '../../server/src/services/column-transform'
import constMod from '../../server/src/lib/constants'
import walMod from '../../server/src/lib/wal-checkpointer'
import { sqliteWriteProbe } from './sqlite-write-probe'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { transformColumn } = transformMod as typeof import('../../server/src/services/column-transform')
const { WAL_PAUSE_FRAMES } = constMod as typeof import('../../server/src/lib/constants')
const { closeWalCheckpointer, setCheckpointDelayForTests, setCheckpointWorkerFileForTests,
  takeWalCheckpointerStats, walCheckpointerIdle } = walMod as typeof import('../../server/src/lib/wal-checkpointer')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}
const quiet = console.error
console.error = (...a: unknown[]) => { if (!String(a[0]).includes('checkpoint')) quiet(...a) }

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const ROWS = 30_000
const NOTES = 'n'.repeat(200)
const uid = uuid(), tid = uuid(), sid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,?,?)')
  .run(sid, tid, uid, 'Big', 0, JSON.stringify(['N', 'Notes']))
const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
db.transaction(() => {
  for (let i = 0; i < ROWS; i++) insert.run(uuid(), sid, uid, i, JSON.stringify({ N: `r${i}`, Notes: NOTES }))
})()
const probe = sqliteWriteProbe(db, process.env.DB_PATH!)
// Reads its own target: a row written twice would end "xx".
const call = (suffix: string, cursor?: string) => transformColumn(uid, { sheetId: sid, operation: 'template',
  template: `{{N}}${suffix}`, targetColumn: 'N', ...(cursor === undefined ? {} : { cursor }) })
const once = (suffix: string) => db.prepare(`SELECT count(*) FROM rows WHERE sheet_id = ?
  AND json_extract(data, '$.N') = 'r' || row_index || ?`).pluck().get(sid, suffix) as number

// Every call of a pass, from the top to its last next_cursor, the event loop's longest stretch measured.
async function pass(suffix: string) {
  let lastTick = performance.now(), loopMax = 0
  const sampler = setInterval(() => {
    const now = performance.now()
    loopMax = Math.max(loopMax, now - lastTick)
    lastTick = now
  }, 5)
  const t0 = performance.now()
  let calls = 0
  try {
    for (let cursor: string | undefined; ;) {
      const out = await call(suffix, cursor)
      assert.ok('ok' in out, JSON.stringify(out))
      calls++
      cursor = out.ok.next_cursor
      if (cursor === undefined) break
    }
  } finally { clearInterval(sampler) }
  return { calls, ms: Math.round(performance.now() - t0), loopMaxMs: Math.round(loopMax) }
}

async function main() {
  await check('checkpoints of over a second: the walk waits for the worker between pages, the loop is never '
    + 'held 200 ms, no checkpoint runs on the API connection, the WAL stays bounded, every row is written once',
  async () => {
    probe.reset()
    takeWalCheckpointerStats()
    setCheckpointDelayForTests(1100)
    try {
      const run = await pass('x')
      await walCheckpointerIdle()
      const w = probe.read()
      const k = takeWalCheckpointerStats()
      console.log('     ', JSON.stringify({ ...run, checkpoints: k.checkpoints, onThisThread: k.onThisThread,
        waits: k.pauses, waitedMs: k.pausedMs, mainCheckpoints: w.checkpoints, walReads: w.walReads,
        mostPageFrames: w.mostTransactionFrames, mostWalFrames: w.mostWalFrames }))
      assert.ok(run.loopMaxMs < 200, `the event loop was held ${run.loopMaxMs} ms`)
      assert.equal(w.checkpoints, 0, 'a checkpoint ran on the API connection')
      assert.ok(w.walReads > 0)
      assert.ok(k.pauses > 0 && k.pausedMs >= 1000, `the walk didn't wait for the worker: ${JSON.stringify(k)}`)
      assert.equal(k.onThisThread, 0)
      assert.ok(w.mostWalFrames <= WAL_PAUSE_FRAMES + w.mostTransactionFrames,
        `the WAL held ${w.mostWalFrames} frames, past ${WAL_PAUSE_FRAMES} and a page (${w.mostTransactionFrames})`)
      assert.equal(once('x'), ROWS)
    } finally { setCheckpointDelayForTests(0) }
  })

  await check('no worker (its file fails to load): the checkpoints run on the API thread; closed, a later use '
    + 'starts a new worker', async () => {
    await closeWalCheckpointer()
    setCheckpointWorkerFileForTests(`${process.env.DB_PATH}-no-such-worker.js`)
    try {
      takeWalCheckpointerStats()
      await pass('y')
      await walCheckpointerIdle()
      const k = takeWalCheckpointerStats()
      assert.ok(k.checkpoints > 0 && k.onThisThread === k.checkpoints, JSON.stringify(k))
      assert.equal(once('xy'), ROWS)
    } finally { setCheckpointWorkerFileForTests(null) }
    await closeWalCheckpointer()
    takeWalCheckpointerStats()
    await pass('z')
    await walCheckpointerIdle()
    const k = takeWalCheckpointerStats()
    assert.ok(k.checkpoints > 0 && k.onThisThread === 0, JSON.stringify(k))
    assert.equal(once('xyz'), ROWS)
  })
  await closeWalCheckpointer()
}

main()
  .catch(e => { failures++; console.log('FAIL threw', e) })
  .finally(() => {
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
    console.log('All transform-wal-slow assertions passed.')
    process.exit(0)
  })
