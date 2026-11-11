// transform_column on 300,000 rows (services/column-transform-pages.ts) walks
// the sheet a page at a time: while its calls run, the server answers a REST
// read within 200 ms and the event loop is never held 200 ms, and memory stays
// that of a page, not of the sheet. A where matching nothing writes nothing (no
// '' into every row: the new column is only listed); one matching every row
// writes every row exactly once over calls of at most TRANSFORM_MAX_ROWS rows,
// each going on from the call before's next_cursor. Numbers are printed.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { performance } from 'node:perf_hooks'
import express from 'express'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import transformMod from '../../server/src/services/column-transform'
import constMod from '../../server/src/lib/api-v1-constants'
import sheetsMod from '../../server/src/routes/api-v1-sheets'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { transformColumn } = transformMod as typeof import('../../server/src/services/column-transform')
const { TRANSFORM_MAX_ROWS } = constMod as typeof import('../../server/src/lib/api-v1-constants')
const { default: sheetsRouter } = sheetsMod as unknown as { default: express.Router }
type Params = import('../../server/src/services/column-transform').TransformParams

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}

const ROWS = 300_000
const NOTES = 'n'.repeat(200)
const uid = uuid(), tid = uuid(), sid = uuid(), small = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
const addSheet = db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,?,?)')
addSheet.run(sid, tid, uid, 'Big', 0, JSON.stringify(['Name', 'Notes']))
addSheet.run(small, tid, uid, 'Small', 1, JSON.stringify(['Name']))
const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
db.transaction(() => {
  for (let i = 0; i < ROWS; i++) insert.run(uuid(), sid, uid, i, JSON.stringify({ Name: `p${i}`, Notes: NOTES }))
  for (let i = 0; i < 5; i++) insert.run(uuid(), small, uid, i, JSON.stringify({ Name: `s${i}` }))
})()

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
    let heap = 0, rss = 0, lastTick = performance.now(), loopMax = 0
    const tick = () => {
      const now = performance.now()
      loopMax = Math.max(loopMax, now - lastTick)
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
    await pinging
    const mb = (n: number) => Math.round(n / 1048576)
    const stats = { calls: calls.length, ms: Math.round(ms), answered, slowestMs: Math.round(slowest),
      loopMaxMs: Math.round(loopMax), heapMb: mb(heap), rssMb: mb(rss) }
    console.log('     ', params.targetColumn, JSON.stringify(stats))
    return { calls, stats }
  }
  const stored = (column: string) => db.prepare(`SELECT count(*) FROM rows WHERE sheet_id = ?
    AND json_extract(data, ?) IS NOT NULL`).pluck().get(sid, `$."${column}"`) as number

  await check(`a where matching none of ${ROWS} rows: nothing written, the server answers, memory stays a page's`,
    async () => {
      const { calls, stats } = await measured({ sheetId: sid, operation: 'upper', sourceColumn: 'Name',
        targetColumn: 'Nothing', where: [{ column: 'Name', operator: 'eq', value: 'nobody' }] })
      assert.ok(stats.answered >= 5 && stats.slowestMs < 200 && stats.loopMaxMs < 200, JSON.stringify(stats))
      assert.equal(calls.reduce((n, c) => n + c.updated, 0), 0)
      assert.deepEqual(calls[0].created_column, 'Nothing')
      assert.equal(stored('Nothing'), 0, 'no row stores the new column')
      assert.ok(stats.heapMb < 64, `heap grew ${stats.heapMb} MB`)
    })

  await check(`a where matching every one of ${ROWS} rows: each written once, at most ${TRANSFORM_MAX_ROWS} a call`,
    async () => {
      const { calls, stats } = await measured({ sheetId: sid, operation: 'template', template: '{{Name}}!',
        targetColumn: 'Every', where: [{ column: 'Name', operator: 'not_empty' }] })
      assert.equal(calls.reduce((n, c) => n + c.updated, 0), ROWS)
      assert.ok(calls.every(c => c.updated <= TRANSFORM_MAX_ROWS), JSON.stringify(calls.map(c => c.updated)))
      assert.deepEqual(calls.map(c => c.created_column), ['Every', ...calls.slice(1).map(() => null)])
      const right = db.prepare(`SELECT count(*) FROM rows WHERE sheet_id = ?
        AND json_extract(data, '$.Every') = json_extract(data, '$.Name') || '!'`).pluck().get(sid)
      assert.equal(right, ROWS)
      assert.ok(stats.answered >= 5 && stats.slowestMs < 200 && stats.loopMaxMs < 200, JSON.stringify(stats))
      assert.ok(stats.heapMb < 64, `heap grew ${stats.heapMb} MB`)
    })

  server.close()
}

main()
  .catch(e => { failures++; console.log('FAIL threw', e) })
  .finally(() => {
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
    console.log('All transform-pages assertions passed.')
    process.exit(0)
  })
