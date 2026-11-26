// What firing a run schedule now would cost (services/run-schedule-estimate.ts), on a migrated throwaway DB with an
// AI column on a priced model (OpenRouter's model list from a stand-in): a sheet's schedule is priced as run_columns'
// estimate_only prices the same columns and rows; one over its max_cost_usd says why it wouldn't start, as its
// firing would; a table's schedule shares its max_cost_usd in sheet order, so a sheet left without room is named
// in problems and not priced; an HTTP API column is its requests with no price; and nothing starts or is written.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { passed } from './ends-on-its-own'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
const prices = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    const pricing = { prompt: '0.00001', completion: '0.00003' }
    res.end(JSON.stringify({ data: [{ id: 'test/priced', name: 'p', pricing }] }))
  })
})
await new Promise<void>(resolve => prices.listen(0, '127.0.0.1', resolve))
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(prices.address() as AddressInfo).port}/api/v1`
const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const store = await import('../../server/src/services/run-schedule-store')
const { estimateScheduleFiring } = await import('../../server/src/services/run-schedule-estimate')
const { runColumns } = await import('../../server/src/services/column-run')
runMigrations()
console.warn = () => {}

let failures = 0
async function check(label: string, fn: () => unknown) {
  try { await fn(); console.log('ok  ', label) } catch (e) {
    failures++; console.log('FAIL', label, '\n ', (e as Error).message)
  }
}
const ok = <T>(out: { ok: T } | { fail: string; message: string }): T => {
  if ('fail' in out) throw new Error(out.message)
  return out.ok
}
const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'Priced')
// Two sheets, each with an AI column "Fit (Output)" on the priced model over 3 filled rows; P1 also has an HTTP
// API column "Ping".
const [p1, p2] = ['P1', 'P2'].map((name, k) => {
  const sid = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,column_order,position) VALUES (?,?,?,?,?,?)')
    .run(sid, tid, uid, name, JSON.stringify(['Name', 'Fit (Output)', ...(k === 0 ? ['Ping'] : [])]), k)
  for (let i = 0; i < 3; i++) {
    db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
      .run(uuid(), sid, uid, i, JSON.stringify({ Name: `P${i}`, 'Fit (Output)': 'x', Ping: '200' }))
  }
  db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,model,status,total_rows)
    VALUES (?,?,?,'Fit (Output)','Describe /name','test/priced','completed',3)`).run(uuid(), sid, uid)
  return sid
})
db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name,total_rows)
  VALUES (?,?,?,?,'completed','Ping',3)`).run(uuid(), p1, uid, JSON.stringify({
  requestConfig: { url: 'https://example.com/ping?q={{Name}}', method: 'GET', headers: {} }, responseMapping: [],
  previewSize: 5 }))
const caller = { hasSecretsScope: false }
const daily = { rows: 'all', cadence: 'daily', at_time: '09:00', time_zone: 'UTC' }
const fit = ok(await runColumns(uid, p1, { columns: ['Fit (Output)'], mode: 'all', rowIds: null, where: null,
  estimateOnly: true, maxCostUsd: null, allowUnpriced: false, webhookId: null }, caller)) as { estimate: any }
const need = fit.estimate.high_usd + fit.estimate.row_most_usd
// Every estimate starts nothing and writes nothing: no run, no usage, no History line, the schedule as it was.
const written = () => JSON.stringify(['setup_runs', 'ai_runs', 'http_runs', 'run_usage', 'sheet_changes']
  .map(t => db.prepare(`SELECT COUNT(*) FROM ${t}`).pluck().get())
  .concat(db.prepare('SELECT * FROM run_schedules ORDER BY id').all() as never[]))
async function estimate(id: string) {
  const before = written()
  const out = await estimateScheduleFiring(uid, id, caller)
  assert.equal(written(), before, 'an estimate wrote something')
  return ok(out)
}

await check("a sheet's schedule: priced as run_columns prices the same columns and rows", async () => {
  assert.ok(need > 0 && fit.estimate.high_usd > 0, JSON.stringify(fit.estimate))
  const s = ok(store.createSchedule(uid, { ...daily, sheet_id: p1, columns: ['Fit (Output)'] }, caller))
  const e = await estimate(s.id)
  assert.deepEqual(e.problems, [])
  assert.deepEqual(e.sheets.map(x => x.sheet_id), [p1])
  assert.deepEqual([e.low_usd, e.high_usd], [fit.estimate.low_usd, fit.estimate.high_usd])
  assert.equal(e.sheets[0].estimate.columns[0].rows, 3)
})

await check('every run column: an HTTP API column is its requests, with no price', async () => {
  const s = ok(store.createSchedule(uid, { ...daily, sheet_id: p1 }, caller))
  const e = await estimate(s.id)
  const ping = e.sheets[0].estimate.columns.find(c => c.column === 'Ping')!
  assert.deepEqual([ping.sends_requests, ping.rows, ping.high_usd], [true, 3, null])
  assert.equal(e.high_usd, fit.estimate.high_usd)
})

await check("over its max_cost_usd: not priced, and why it wouldn't start", async () => {
  const s = ok(store.createSchedule(uid, { ...daily, sheet_id: p1, columns: ['Fit (Output)'],
    max_cost_usd: need / 2 }, caller))
  const e = await estimate(s.id)
  assert.deepEqual(e.sheets, [])
  assert.equal(e.problems.length, 1)
  assert.match(e.problems[0], /more than the \$[\d.]+ ceiling/)
})

await check("a table's schedule shares its max_cost_usd: the sheet left without room is named, not priced",
  async () => {
    const s = ok(store.createSchedule(uid, { ...daily, table_id: tid, columns: ['Fit (Output)'],
      max_cost_usd: need * 1.5 }, caller))
    const e = await estimate(s.id)
    assert.deepEqual(e.sheets.map(x => x.sheet_id), [p1])
    assert.equal(e.problems.length, 1)
    assert.match(e.problems[0], /^P2: /)
    const roomy = ok(store.changeSchedule(uid, s.id, { max_cost_usd: need * 3 }, caller))
    const both = await estimate(roomy.id)
    assert.deepEqual([both.sheets.map(x => x.sheet_id), both.problems], [[p1, p2], []])
    assert.equal(both.high_usd, Math.round(fit.estimate.high_usd * 2 * 1e4) / 1e4)
  })

await check('an unknown schedule is not found', async () => {
  assert.deepEqual(await estimateScheduleFiring(uid, uuid(), caller), { fail: 'not_found',
    message: 'Schedule not found' })
})

prices.close()
if (failures > 0) { console.error(`${failures} run-schedule-estimate check(s) failed`); process.exit(1) }
console.log('run-schedule-estimate: all assertions passed')
passed()
