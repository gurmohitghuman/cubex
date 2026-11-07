// Over 200 lines: the mock treg, the stand-in API and the app's routes serve every case; split, each rebuilds them.
// Enrichment and waterfall runs never send another run's ⏳ cells. While a column their inputs read is held by
// a run (still going, or stopped and putting its ⏳ cells back), an enrichment's start (the app's route; /api/v1,
// MCP and a setup step call the same service) and its resume are refused with the shared words, nothing made,
// queued or called; a waterfall's start too. A running enrichment's or waterfall's rows wait instead
// (services/run-input-gate.ts): nothing is called while the column is held, then each row reads the value that run
// left; a waterfall row no longer reads the ⏳ as empty and skips itself as missing an input, while a cell that
// is really empty still skips. treg is the repo's mock (tests/mock-treg), started here; the waterfall's HTTP
// step reaches a stand-in through Cubex's real outbound path (tests/e2e/net-shim.cjs).
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import express from 'express'
import cookieParser from 'cookie-parser'
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// The mock treg, on a port of its own; stopped when this test ends.
const tregPort = await new Promise<number>(resolve => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = (s.address() as AddressInfo).port
    s.close(() => resolve(p))
  })
})
const treg = spawn(process.execPath, ['tests/mock-treg/server.mjs', String(tregPort)], { stdio: 'ignore' })
process.on('exit', () => treg.kill())
const TREG = `http://127.0.0.1:${tregPort}`
for (;;) {
  try { if ((await fetch(`${TREG}/health`)).ok) break } catch { /* not up yet */ }
  await sleep(50)
}
process.env.TREG_BASE_URL = TREG
// What the runs asked treg for: each call's inputs.
const tregCalls = async () => ((await (await fetch(`${TREG}/__mock/requests`)).json()) as
  Array<{ path: string; body: string }>).filter(r => r.path.startsWith('/call/')).map(r => JSON.parse(r.body))

// The stand-in API a waterfall's HTTP step calls: keeps each request's query, answers an email.
const asked: string[] = []
const stand = http.createServer((req, res) => {
  asked.push(new URL(req.url ?? '/', 'http://x').searchParams.get('d') ?? '')
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end('{"email":"x@y.example"}')
})
await new Promise<void>(r => stand.listen(0, '127.0.0.1', r))
process.env.E2E_RECEIVER_PORT = String((stand.address() as AddressInfo).port)
createRequire(import.meta.url)('../e2e/net-shim.cjs')

const { undoKit } = await import('./run-undo-kit')
const { signToken } = await import('../../server/src/lib/auth')
const { seedProcessingPlaceholders, PLACEHOLDER } = await import('../../server/src/lib/placeholder-cells')
const { clearRunPlaceholders } = await import('../../server/src/lib/run-placeholders')
const { processHTTPRun } = await import('../../server/src/services/http-runner')
const { pauseRun } = await import('../../server/src/services/run-lifecycle')
const { saveTregToken } = await import('../../server/src/services/treg-key')
const enrichRoutes = (await import('../../server/src/routes/enrich-runs')).default
const waterfallRoutes = (await import('../../server/src/routes/waterfall')).default
const { db, uid, ok, done, idle, sheet, cells } = undoKit('enrich-held-inputs')
console.error = () => {}
saveTregToken(uid, 'treg_mock_unit_team_key')

// The one Sidequest the server's queue.ts holds: its enqueue only records the job, run below as the worker would.
const queued: Array<{ job: string; args: unknown[] }> = []
createRequire(path.resolve('server/src/queue.ts'))('sidequest').Sidequest.build = (job: { name: string }) => ({
  enqueue: async (...args: unknown[]) => { queued.push({ job: job.name, args }); return {} },
})
async function work(from: number) {
  for (const { job, args } of queued.slice(from)) {
    if (job === 'HTTPRunJob') await processHTTPRun(args[0] as string, args[1] as number)
    else await processHTTPRun(args[0] as string, args[2] as number, args[1] as number[])
  }
}

const app = express()
app.use(cookieParser())
app.use(express.json())
app.use('/api/enrich', enrichRoutes)
app.use('/api/waterfall', waterfallRoutes)
const server = app.listen(0)
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const cookie = `cubex_session=${signToken({ userId: uid, sessionEpoch: 0 })}`
const post = async (route: string, body: unknown) => {
  const res = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

// A work email lookup from Name and Website, into Email.
const enrichment = () => ({
  toolId: 'treg.people.email.find', preset: null, columnName: 'Work email', continueColumn: false,
  inputs: { full_name: { column: 'Name' }, domain: { column: 'Website' } }, cleanDomains: false,
  providerOrder: [], skipProviders: [], stopAtFirst: false, email: null,
  outputs: [{ key: 'email', path: '$.output.email', columnName: 'Email' }], rows: { mode: 'all', test: false },
  conditions: [], maxCostPerRowUsd: null, spendLimitUsd: null, fresh: true,
})
// A waterfall with one HTTP step reading the domain.
const waterfall = () => ({
  columnName: 'Found', resultType: 'email', fresh: true,
  inputs: [{ key: 'domain', label: 'Company domain', source: { column: 'Website' } }],
  steps: [{ label: 'Own API', choices: { kind: 'http', method: 'GET', valuePath: '$.email', retries: 0,
    url: `http://api.cubex-e2e.invalid:${process.env.E2E_RECEIVER_PORT}/find?d={{domain}}` } }],
})
const fresh = () => sheet([{ Name: 'Ada Lovelace', Website: 'old-a.example' },
  { Name: 'Bob Stone', Website: 'old-b.example' }], ['Name', 'Website'])
const GOING = 'The request reads "Website", which a run that hasn\'t finished is still filling. '
  + 'Wait for that run to finish (or stop it), then try again.'
const BACK = 'The request reads "Website", which is getting back what it held before a stopped run. '
  + 'Try again in a moment.'
// A rerun of Website starting: its ⏳ in every row.
async function hold(sid: string, rows = 2) {
  const run = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,'{}','running','Website')`).run(run, sid, uid)
  await seedProcessingPlaceholders({ run: { kind: 'http', id: run }, sheetId: sid, userId: uid, columns: ['Website'],
    targets: null, lastRow: rows - 1, live: () => true })
  return {
    finish: (values: string[]) => db.transaction(() => {
      values.forEach((v, i) => db.prepare(`UPDATE rows SET data = json_set(data, '$.Website', ?)
        WHERE sheet_id = ? AND row_index = ?`).run(v, sid, i))
      db.prepare(`UPDATE http_runs SET status = 'completed' WHERE id = ?`).run(run)
    })(),
    stop: () => db.prepare(`UPDATE http_runs SET status = 'cancelled', placeholder_work = 'clearing'
      WHERE id = ?`).run(run),
    back: () => clearRunPlaceholders('http', run),
  }
}
const runsOn = (sid: string) => db.prepare('SELECT COUNT(*) FROM http_runs WHERE sheet_id = ?').pluck().get(sid)
const domains = async (from: number) => (await tregCalls()).slice(from).map(c => c.domain).sort()

await ok('an enrichment start (the app\'s route) reading a column a run holds: refused, nothing made, queued or '
  + 'called; after the clear it calls with the values put back', async () => {
  const sid = fresh()
  const h = await hold(sid)
  const start = () => post(`/api/enrich/sheets/${sid}/runs`, enrichment())
  const before = { calls: (await tregCalls()).length, queued: queued.length }
  assert.deepEqual(await start(), { status: 409, body: { error: GOING } })
  h.stop()
  assert.deepEqual(await start(), { status: 409, body: { error: BACK } })
  assert.equal(runsOn(sid), 1, 'no run made')
  assert.deepEqual({ calls: (await tregCalls()).length, queued: queued.length }, before, 'nothing called or queued')
  await h.back()
  const res = await start()
  assert.equal(res.status, 200, JSON.stringify(res.body))
  await idle(sid)
  await work(before.queued)
  assert.deepEqual(await domains(before.calls), ['old-a.example', 'old-b.example'])
})

await ok('a paused enrichment\'s resume (the app\'s route) reading a column a run holds: refused, it stays paused '
  + 'with its run limit; after the clear it resumes and calls with the values put back', async () => {
  const sid = fresh()
  const from = { calls: (await tregCalls()).length, queued: queued.length }
  const res = await post(`/api/enrich/sheets/${sid}/runs`, enrichment())
  const id = res.body.runId as string
  await idle(sid)
  assert.deepEqual(pauseRun('http', id, uid), { ok: true })
  const h = await hold(sid)
  const resume = () => post(`/api/enrich/runs/${id}/resume`, { concurrency: 2 })
  const config = () => db.prepare('SELECT config FROM http_runs WHERE id = ?').pluck().get(id)
  const was = config()
  assert.deepEqual(await resume(), { status: 409, body: { error: GOING } })
  h.stop()
  assert.deepEqual(await resume(), { status: 409, body: { error: BACK } })
  assert.equal(db.prepare('SELECT status FROM http_runs WHERE id = ?').pluck().get(id), 'paused')
  assert.equal(config(), was, 'its settings unchanged')
  await h.back()
  assert.deepEqual(await resume(), { status: 200, body: { ok: true } })
  await work(from.queued)
  assert.deepEqual(await domains(from.calls), ['old-a.example', 'old-b.example'])
})

await ok('a running enrichment whose input a later run fills: its rows wait, nothing is called while it is '
  + 'held, then each calls with the value that run wrote', async () => {
  const sid = fresh()
  const from = { calls: (await tregCalls()).length, queued: queued.length }
  const res = await post(`/api/enrich/sheets/${sid}/runs`, enrichment())
  assert.equal(res.status, 200, JSON.stringify(res.body))
  await idle(sid)
  const h = await hold(sid)
  const going = work(from.queued)
  await sleep(1600)
  assert.deepEqual(await domains(from.calls), [], 'nothing called while Website is held')
  assert.deepEqual(cells(sid, 'Work email'), [PLACEHOLDER, PLACEHOLDER])
  h.finish(['new-a.example', 'new-b.example'])
  await going
  assert.deepEqual(await domains(from.calls), ['new-a.example', 'new-b.example'])
})

await ok('a waterfall start reading a column a run holds: refused, nothing made or queued; after the clear it '
  + 'starts', async () => {
  const sid = fresh()
  const h = await hold(sid)
  const start = () => post(`/api/waterfall/sheets/${sid}/runs`, waterfall())
  const before = queued.length
  assert.deepEqual(await start(), { status: 409, body: { error: GOING } })
  h.stop()
  assert.deepEqual(await start(), { status: 409, body: { error: BACK } })
  assert.equal(runsOn(sid), 1, 'no run made')
  assert.equal(queued.length, before, 'nothing queued')
  await h.back()
  const res = await start()
  assert.equal(res.status, 200, JSON.stringify(res.body))
})

await ok('a running waterfall whose input a later run fills: its rows wait instead of skipping as missing it, '
  + 'then ask with the value that run wrote; a cell really empty still skips', async () => {
  const sid = sheet([{ Website: 'old-a.example' }, { Website: 'old-b.example' }, { Website: 'old-c.example' }],
    ['Website'])
  const from = queued.length
  const res = await post(`/api/waterfall/sheets/${sid}/runs`, waterfall())
  assert.equal(res.status, 200, JSON.stringify(res.body))
  await idle(sid)
  const h = await hold(sid, 3)
  const was = asked.length
  const going = work(from)
  await sleep(1600)
  assert.deepEqual(asked.slice(was), [], 'nothing asked while Website is held')
  assert.deepEqual(cells(sid, 'Found'), [PLACEHOLDER, PLACEHOLDER, PLACEHOLDER])
  h.finish(['new-a.example', 'new-b.example', ''])
  await going
  assert.deepEqual(asked.slice(was).sort(), ['new-a.example', 'new-b.example'])
  assert.deepEqual(cells(sid, 'Found').slice(0, 2), ['x@y.example', 'x@y.example'])
  assert.notEqual(cells(sid, 'Found')[2], PLACEHOLDER, 'the empty row is done, skipped')
})

server.close()
stand.close()
treg.kill()
done()
