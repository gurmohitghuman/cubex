// Over 200 lines: one measured harness (a pass, the REST reads beside it, its numbers) and the cases sharing it.
// transform_column on 300,000 rows (services/column-transform-pages.ts) walks the sheet a page at a time:
// while its calls run, the server answers a REST read within 200 ms and the event loop is never held 200 ms
// (a pass over it is measured again on a new column, up to 3 passes: a CI runner stalls the process now and
// then, about once in eight passes on Windows, and the next pass doesn't stall there, while a slowdown of the
// walk holds every pass), memory stays that of a page, not of the sheet, and one matching every row writes every
// row exactly once over calls of at most TRANSFORM_MAX_ROWS rows, each going on from the call before's next_cursor.
// Both platforms run them: they caught the checkpoint stall, and the WAL starts over about 34 times a pass. No
// transaction on the API connection starts the WAL over: SQLite syncs the new WAL header inside that commit, on
// the event loop (with every WAL sync made 300 ms slow, each such page took 300 ms). The worker starts it over
// after the checkpoints the walk waits for, before answering, so that sync is its own. Checked per transaction
// (the WAL header's checkpoint count and salts, and its frames), which doesn't depend on a disk's speed; the 5
// slowest transactions are printed with those facts each run. On 1,000 rows: a where matching nothing writes
// nothing (no '' into every row: the new column is only listed) and asks for no checkpoint; one row written
// asks for one, on the worker, at the end of its call. No checkpoint runs on the API connection (a
// checkpoint's disk sync held a slow CI disk's server 628 ms): the WAL is copied back on the checkpoint
// worker's thread (lib/wal-checkpointer.ts), and no page's commit runs SQLite's own checkpoint (it copied
// 2,000 frames back inside about one page commit in fifty): the WAL never holds the frames that start it.
// Numbers are printed: the longest page transaction, the worker's checkpoints and waits
// (sqlite-write-probe.ts), and the walk's turns (lib/wal-turn.ts): asks for the WAL to start over, of them those a
// transaction's first statement made (it began with every frame copied), and waits for the worker's turn.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { performance, PerformanceObserver } from 'node:perf_hooks'
import express from 'express'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import transformMod from '../../server/src/services/column-transform'
import constMod from '../../server/src/lib/api-v1-constants'
import sheetsMod from '../../server/src/routes/api-v1-sheets'
import walMod from '../../server/src/lib/wal-checkpointer'
import turnMod from '../../server/src/lib/wal-turn'
import { sqliteWriteProbe, transactionLine } from './sqlite-write-probe'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { transformColumn } = transformMod as typeof import('../../server/src/services/column-transform')
const { TRANSFORM_MAX_ROWS } = constMod as typeof import('../../server/src/lib/api-v1-constants')
const { default: sheetsRouter } = sheetsMod as unknown as { default: express.Router }
const { checkpointAsked, closeWalCheckpointer, takeWalCheckpointerStats, walCheckpointerIdle } =
  walMod as typeof import('../../server/src/lib/wal-checkpointer')
const { takeWalTurnStats } = turnMod as typeof import('../../server/src/lib/wal-turn')
type Params = import('../../server/src/services/column-transform').TransformParams

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}

const ROWS = 300_000
const FEW = 1_000
const NOTES = 'n'.repeat(200)
const uid = uuid(), tid = uuid(), sid = uuid(), small = uuid(), few = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
const addSheet = db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,?,?)')
addSheet.run(sid, tid, uid, 'Big', 0, JSON.stringify(['Name', 'Notes']))
addSheet.run(small, tid, uid, 'Small', 1, JSON.stringify(['Name']))
addSheet.run(few, tid, uid, 'Few', 2, JSON.stringify(['Name', 'Notes']))
const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
db.transaction(() => {
  for (let i = 0; i < ROWS; i++) insert.run(uuid(), sid, uid, i, JSON.stringify({ Name: `p${i}`, Notes: NOTES }))
  for (let i = 0; i < FEW; i++) insert.run(uuid(), few, uid, i, JSON.stringify({ Name: `p${i}`, Notes: NOTES }))
  for (let i = 0; i < 5; i++) insert.run(uuid(), small, uid, i, JSON.stringify({ Name: `s${i}` }))
}).immediate()
const probe = sqliteWriteProbe(db, process.env.DB_PATH!, checkpointAsked)

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function main() {
  const app = express()
  app.use((req, _res, next) => { Object.assign(req, { userId: uid, tokenScopes: new Set(['read']) }); next() })
  app.use(sheetsRouter)
  // Only this machine can reach it; the port is read once it listens.
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const read = `http://127.0.0.1:${(server.address() as AddressInfo).port}/sheets/${small}/rows?limit=5`

  // Every call of a transform, from the top to its last next_cursor, while another request reads every 10 ms.
  async function measured(params: Params) {
    const calls: Array<{ updated: number; created_column: string | null; next_cursor?: string }> = []
    let running = true, answered = 0, slowest = 0
    // Emptying the WAL is the test's own work: done before anything is timed.
    await walCheckpointerIdle()
    probe.reset()
    takeWalCheckpointerStats()
    takeWalTurnStats()
    const pinging = (async () => {
      while (running) {
        const t0 = performance.now()
        const res = await fetch(read)
        assert.equal(res.status, 200)
        await res.text()
        slowest = Math.max(slowest, performance.now() - t0)
        answered++
        await sleep(10)
      }
    })()
    while (answered === 0) await sleep(5)
    const before = process.memoryUsage()
    // The event loop's longest stretch: the gap between two ticks of a 5 ms timer, up to the end of the calls.
    let heap = 0, rss = 0, lastTick = performance.now(), loopMax = 0, loopMaxAt = 0, gcMax = 0
    // Garbage collection's longest pause, printed: a stretch outside every page is that or the machine.
    const gc = new PerformanceObserver(list => {
      for (const e of list.getEntries()) gcMax = Math.max(gcMax, e.duration)
    })
    gc.observe({ entryTypes: ['gc'] })
    const tick = () => {
      const now = performance.now()
      if (now - lastTick > loopMax) { loopMax = now - lastTick; loopMaxAt = lastTick }
      lastTick = now
      const m = process.memoryUsage()
      heap = Math.max(heap, m.heapUsed - before.heapUsed)
      rss = Math.max(rss, m.rss - before.rss)
    }
    const sampler = setInterval(tick, 5)
    const t0 = performance.now()
    try {
      for (let cursor: string | undefined; ;) {
        const out = await transformColumn(uid, { ...params, ...(cursor === undefined ? {} : { cursor }) })
        assert.ok('ok' in out, JSON.stringify(out))
        calls.push(out.ok)
        cursor = out.ok.next_cursor
        if (cursor === undefined) break
      }
    } finally {
      running = false
      tick()
      clearInterval(sampler)
    }
    const ms = performance.now() - t0
    for (const e of gc.takeRecords()) gcMax = Math.max(gcMax, e.duration)
    gc.disconnect()
    await pinging
    // The checkpoint the last call asked for, counted once it ends.
    await walCheckpointerIdle()
    const mb = (n: number) => Math.round(n / 1048576)
    const w = probe.read()
    const k = takeWalCheckpointerStats()
    const turn = takeWalTurnStats()
    const records = probe.records()
    // The longest stretch fell in a page when one page's transaction took at least half of it.
    const inPage = records.some(r => r.at < loopMaxAt + loopMax && loopMaxAt < r.at + r.ms && r.ms * 2 >= loopMax)
    const stats = { calls: calls.length, ms: Math.round(ms), answered, slowestMs: Math.round(slowest),
      loopMaxMs: Math.round(loopMax), heapMb: mb(heap), rssMb: mb(rss), pages: w.transactions,
      longestPageMs: Math.round(w.longestTransactionMs), mostPageFrames: w.mostTransactionFrames,
      workerCheckpoints: k.checkpoints - k.onThisThread, onThisThread: k.onThisThread, waits: k.pauses,
      waitedMs: k.pausedMs, workerRestarts: k.restarts, mainCheckpoints: w.checkpoints,
      mostWalFrames: w.mostWalFrames, asks: turn.asks, caughtInside: turn.caughtInside, turnWaits: turn.turnWaits,
      gcMaxMs: Math.round(gcMax), longestIn: inPage ? 'a page' : 'no page' }
    console.log('     ', params.targetColumn, JSON.stringify(stats))
    const startedOver = records.filter(r => r.startedOver)
    console.log(`      ${params.targetColumn}: ${records.length} transactions, ${startedOver.length} started the WAL `
      + 'over on this thread; the 5 slowest:')
    for (const r of probe.slowest(5)) console.log(`        ${transactionLine(r)}`)
    return { calls, stats, startedOver }
  }
  // The server's bound, on the walk: a pass over it is measured again on a new column, up to PASSES in all, and
  // the case fails only when every pass goes over. On CI, one pass held the loop 315 ms in one page while its 1,231
  // others took under 31 ms, another 207 ms outside any page; the next pass didn't.
  const BOUND_MS = 200, PASSES = 3
  async function withinBound(target: string, params: (targetColumn: string) => Params) {
    const over: object[] = []
    for (let n = 1; n <= PASSES; n++) {
      const name = n === 1 ? target : `${target} ${n}`
      const run = await measured(params(name))
      if (run.stats.slowestMs < BOUND_MS && run.stats.loopMaxMs < BOUND_MS) return { ...run, target: name }
      over.push(run.stats)
      // One plain line a pass over the bound, so CI logs show how often it happens.
      const again = n < PASSES ? '; measured again' : ''
      console.log(`      OVER ${target}, pass ${n} of ${PASSES}: loopMaxMs ${run.stats.loopMaxMs}, slowestMs `
        + `${run.stats.slowestMs}, the longest stretch in ${run.stats.longestIn}${again}`)
    }
    return assert.fail(`every pass held the server ${BOUND_MS} ms or more: ${JSON.stringify(over)}`)
  }
  const stored = (column: string, sheet = sid) => db.prepare(`SELECT count(*) FROM rows WHERE sheet_id = ?
    AND json_extract(data, ?) IS NOT NULL`).pluck().get(sheet, `$."${column}"`) as number

  await check(`on ${FEW} rows, a where matching none: nothing written, no checkpoint; one matching only the first `
    + 'row: one checkpoint, on the worker, once the call ends', async () => {
    const none = await measured({ sheetId: few, operation: 'upper', sourceColumn: 'Name', targetColumn: 'Nothing',
      where: [{ column: 'Name', operator: 'eq', value: 'nobody' }] })
    assert.equal(none.calls.reduce((n, c) => n + c.updated, 0), 0)
    assert.deepEqual(none.calls.map(c => c.created_column), ['Nothing'])
    assert.equal(stored('Nothing', few), 0, 'no row stores the new column')
    assert.equal(none.stats.workerCheckpoints + none.stats.mainCheckpoints, 0,
      `${none.stats.workerCheckpoints + none.stats.mainCheckpoints} checkpoints after pages that wrote nothing`)
    const first = await measured({ sheetId: few, operation: 'upper', sourceColumn: 'Name', targetColumn: 'First',
      where: [{ column: 'Name', operator: 'eq', value: 'p0' }] })
    assert.equal(first.calls.reduce((n, c) => n + c.updated, 0), 1)
    assert.deepEqual([first.stats.workerCheckpoints, first.stats.onThisThread, first.stats.mainCheckpoints], [1, 0, 0])
    assert.equal(stored('First', few), 1)
  })

  const NONE = `a where matching none of ${ROWS} rows: nothing written, the server answers, memory stays a page's`
  await check(NONE, async () => {
    const { calls, stats, target } = await withinBound('Nothing', targetColumn => ({ sheetId: sid,
      operation: 'upper', sourceColumn: 'Name', targetColumn,
      where: [{ column: 'Name', operator: 'eq', value: 'nobody' }] }))
    assert.ok(stats.answered >= 5, JSON.stringify(stats))
    assert.ok(stats.mostWalFrames < probe.autoCheckpointFrames, `the WAL held ${stats.mostWalFrames} frames: `
      + `SQLite's own checkpoint (at ${probe.autoCheckpointFrames}) ran inside a page's commit`)
    assert.equal(calls.reduce((n, c) => n + c.updated, 0), 0)
    assert.equal(stats.workerCheckpoints + stats.mainCheckpoints, 0,
      `${stats.workerCheckpoints + stats.mainCheckpoints} checkpoints after pages that wrote nothing`)
    assert.deepEqual(calls[0].created_column, target)
    assert.equal(stored(target), 0, 'no row stores the new column')
    assert.ok(stats.heapMb < 64, `heap grew ${stats.heapMb} MB`)
  })

  const EVERY = `a where matching every one of ${ROWS} rows: each written once, at most ${TRANSFORM_MAX_ROWS} a call`
  await check(EVERY, async () => {
    const { calls, stats, startedOver, target } = await withinBound('Every', targetColumn => ({ sheetId: sid,
      operation: 'template', template: '{{Name}}!', targetColumn, where: [{ column: 'Name', operator: 'not_empty' }] }))
    assert.equal(calls.reduce((n, c) => n + c.updated, 0), ROWS)
    assert.ok(calls.every(c => c.updated <= TRANSFORM_MAX_ROWS), JSON.stringify(calls.map(c => c.updated)))
    assert.deepEqual(calls.map(c => c.created_column), [target, ...calls.slice(1).map(() => null)])
    const right = db.prepare(`SELECT count(*) FROM rows WHERE sheet_id = ?
      AND json_extract(data, ?) = json_extract(data, '$.Name') || '!'`).pluck().get(sid, `$."${target}"`)
    assert.equal(right, ROWS)
    assert.ok(stats.answered >= 5, JSON.stringify(stats))
    assert.ok(stats.mostWalFrames < probe.autoCheckpointFrames, `the WAL held ${stats.mostWalFrames} frames: `
      + `SQLite's own checkpoint (at ${probe.autoCheckpointFrames}) ran inside a page's commit`)
    assert.equal(stats.mainCheckpoints, 0, 'no checkpoint on the API connection')
    assert.deepEqual(startedOver.map(transactionLine), [], 'transactions that started the WAL over on this thread')
    assert.ok(stats.waits > 0 && stats.workerRestarts > 0, JSON.stringify(stats))
    assert.ok(stats.workerCheckpoints > 0 && stats.onThisThread === 0, JSON.stringify(stats))
    assert.ok(stats.heapMb < 64, `heap grew ${stats.heapMb} MB`)
  })

  server.close()
  await closeWalCheckpointer()
}

main()
  .catch(e => { failures++; console.log('FAIL threw', e) })
  .finally(() => {
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
    console.log('All transform-pages assertions passed.')
    process.exit(0)
  })
