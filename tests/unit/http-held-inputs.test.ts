// Over 200 lines: every HTTP path's case shares one stand-in API, queue and app, so they stay in one file.
// An HTTP API request never goes out with another run's ⏳ cells (lib/http-held-inputs.ts). While a run is
// filling a column the request reads, or a stopped run is still putting that column's cells back, a start
// (the app's route; /api/v1 and MCP call the same service), a rerun, a resume and a preview are refused with
// words naming the column: nothing is written or queued, and no request reaches the stand-in API. Once the
// clear is done each goes through and its requests carry the answers put back. The stand-in is reached through
// Cubex's real outbound path, SSRF guard included (tests/e2e/net-shim.cjs moves the connection to it); the job
// queue only records, and each queued job is then run here, as the worker would. A run's own columns never
// hold it up (a resume of a run whose request reads its own output column goes on), and a preview's mapping
// isn't its own: it writes nothing (/api/v1 and MCP, and their run-start slots: http-held-inputs-token.test.ts).
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import express from 'express'
import cookieParser from 'cookie-parser'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
import authMod from '../../server/src/lib/auth'
import cellsMod from '../../server/src/lib/placeholder-cells'
import placeholdersMod from '../../server/src/lib/run-placeholders'
import rerunMod from '../../server/src/services/http-run-rerun'
import lifecycleMod from '../../server/src/services/run-lifecycle'
import runnerMod from '../../server/src/services/http-runner'
import heldMod from '../../server/src/lib/run-locked-columns'
import startRouterMod from '../../server/src/routes/http-run-start'
import previewRouterMod from '../../server/src/routes/http-preview'
import controlRouterMod from '../../server/src/routes/http-control'
const { signToken } = authMod as typeof import('../../server/src/lib/auth')
const { seedProcessingPlaceholders, PLACEHOLDER } = cellsMod as typeof import('../../server/src/lib/placeholder-cells')
const { clearRunPlaceholders } = placeholdersMod as typeof import('../../server/src/lib/run-placeholders')
const { rerunHttpColumn } = rerunMod as typeof import('../../server/src/services/http-run-rerun')
const { pauseRun } = lifecycleMod as typeof import('../../server/src/services/run-lifecycle')
const { processHTTPRun } = runnerMod as typeof import('../../server/src/services/http-runner')
const { runHeldColumns } = heldMod as typeof import('../../server/src/lib/run-locked-columns')
const routers = [startRouterMod, previewRouterMod, controlRouterMod] as unknown as Array<{ default: express.Router }>
const { db, uid, ok, done, idle, sheet, cells } = undoKit('http-held-inputs')
console.error = () => {}

// The stand-in API: keeps each request's body, answers {"ok": "yes"}.
const sent: string[] = []
const stand = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    sent.push(Buffer.concat(chunks).toString())
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":"yes"}')
  })
})
await new Promise<void>(r => stand.listen(0, '127.0.0.1', r))
process.env.E2E_RECEIVER_PORT = String((stand.address() as AddressInfo).port)
createRequire(import.meta.url)('../e2e/net-shim.cjs')
const URL_ = `http://api.cubex-e2e.invalid:${process.env.E2E_RECEIVER_PORT}/ask`

// The one Sidequest the server's queue.ts holds: its enqueue only records the job and its arguments.
const queued: Array<{ job: string; args: unknown[] }> = []
const { Sidequest } = createRequire(path.resolve('server/src/queue.ts'))('sidequest')
Sidequest.build = (job: { name: string }) => ({
  enqueue: async (...args: unknown[]) => { queued.push({ job: job.name, args }); return {} },
})
// Runs the jobs queued since `from`, as the worker would.
async function work(from: number) {
  for (const { job, args } of queued.slice(from)) {
    if (job === 'HTTPRunJob') await processHTTPRun(args[0] as string, args[1] as number)
    else await processHTTPRun(args[0] as string, args[2] as number, args[1] as number[])
  }
}

const app = express()
app.use(cookieParser())
app.use(express.json())
for (const r of routers) app.use('/api/http', r.default)
const server = app.listen(0)
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const cookie = `cubex_session=${signToken({ userId: uid, sessionEpoch: 0 })}`
const post = async (route: string, body: unknown) => {
  const res = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

// Ask's request reads {{Answer}} and {{Name}}; it writes Got.
const config = () => ({
  requestConfig: { method: 'POST', url: URL_, headers: { 'Content-Type': 'application/json' },
    body: '{"answer":"{{Answer}}","name":"{{Name}}"}' },
  responseMapping: [{ jsonPath: '$.ok', columnName: 'Got' }], previewSize: 2,
})
const OLD = ['{"answer":"Old A","name":"ada"}', '{"answer":"Old B","name":"bob"}']
const GOING = 'The request reads "Answer", which a run that hasn\'t finished is still filling. '
  + 'Wait for that run to finish (or stop it), then try again.'
const BACK = 'The request reads "Answer", which is getting back what it held before a stopped run. '
  + 'Try again in a moment.'

// Earlier answers in Answer, and a sheet's columns as listed.
const fresh = () => sheet([{ Name: 'ada', Answer: 'Old A' }, { Name: 'bob', Answer: 'Old B' }], ['Name', 'Answer'])
const order = (sid: string) => JSON.parse(db.prepare('SELECT column_order FROM sheets WHERE id = ?').pluck()
  .get(sid) as string) as string[]
// A rerun of Answer running, its ⏳ in every row (what Answer held kept first); stop() leaves it as a cancel
// does while its clear goes on, back() finishes the clear.
async function hold(sid: string) {
  const run = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,'{}','running','Answer')`).run(run, sid, uid)
  await seedProcessingPlaceholders({ run: { kind: 'http', id: run }, sheetId: sid, userId: uid, columns: ['Answer'],
    targets: null, lastRow: 1, live: () => true })
  assert.deepEqual(cells(sid, 'Answer'), [PLACEHOLDER, PLACEHOLDER])
  return {
    stop: () => db.prepare(`UPDATE http_runs SET status = 'cancelled', placeholder_work = 'clearing'
      WHERE id = ?`).run(run),
    back: async () => {
      await clearRunPlaceholders('http', run)
      assert.deepEqual(cells(sid, 'Answer'), ['Old A', 'Old B'])
    },
  }
}
// Refused while the run goes, and while its clear goes on: the words, and nothing sent or queued.
async function refusedBoth(h: Awaited<ReturnType<typeof hold>>, attempt: () => Promise<unknown>, expect: unknown[]) {
  const before = { sent: sent.length, queued: queued.length }
  assert.deepEqual(await attempt(), expect[0], 'a running run')
  h.stop()
  assert.deepEqual(await attempt(), expect[1], 'a stopped run still clearing')
  assert.deepEqual({ sent: sent.length, queued: queued.length }, before, 'nothing sent or queued')
}
// Whatever went out since `from`, in row order.
const sentSince = (from: number) => sent.slice(from).sort()

// Ask started from the app and run to the end: its two requests went out, Got filled.
async function startAsk(sid: string) {
  const from = { sent: sent.length, queued: queued.length }
  const res = await post('/api/http/run', { sheetId: sid, masterColumnName: 'Ask', config: config() })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  await idle(sid)
  await work(from.queued)
  assert.deepEqual(sentSince(from.sent), OLD)
  assert.deepEqual(cells(sid, 'Got'), ['yes', 'yes'])
  return res.body.runId as string
}

await ok('a start (the app\'s route) reading a column a run holds: refused, nothing made, sent or queued; '
  + 'after the clear it sends the answers put back', async () => {
  const sid = fresh()
  const h = await hold(sid)
  const start = () => post('/api/http/run', { sheetId: sid, masterColumnName: 'Ask', config: config() })
  await refusedBoth(h, start, [{ status: 409, body: { error: GOING } }, { status: 409, body: { error: BACK } }])
  assert.deepEqual(order(sid), ['Name', 'Answer'], 'no column made')
  assert.equal(db.prepare('SELECT COUNT(*) FROM http_runs WHERE sheet_id = ?').pluck().get(sid), 1, 'no run made')
  await h.back()
  await startAsk(sid)
})

await ok('a rerun whose stored request reads a column a run holds: refused, nothing sent; after the clear it '
  + 'sends the answers put back', async () => {
  const sid = fresh()
  await startAsk(sid)
  const h = await hold(sid)
  const runs = () => db.prepare('SELECT COUNT(*) FROM http_runs WHERE sheet_id = ?').pluck().get(sid)
  assert.equal(runs(), 2, "Ask's run and the one holding Answer")
  const rerun = () => rerunHttpColumn(uid, { sheetId: sid, masterColumnName: 'Ask' })
  // held: the column, so a setup's step waits for it (services/setup-runner.ts).
  await refusedBoth(h, rerun, [{ fail: 'conflict', message: GOING, held: { column: 'Answer', hold: 'going' } },
    { fail: 'conflict', message: BACK, held: { column: 'Answer', hold: 'clearing' } }])
  assert.equal(runs(), 2, 'no run made')
  assert.deepEqual(cells(sid, 'Got'), ['yes', 'yes'], 'its cells untouched')
  await h.back()
  const from = { sent: sent.length, queued: queued.length }
  const out = await rerun()
  assert.ok('ok' in out, JSON.stringify(out))
  await idle(sid)
  await work(from.queued)
  assert.deepEqual(sentSince(from.sent), OLD)
})

await ok('a resume (the app\'s control route) of a paused run reading a column a run holds: refused, it stays '
  + 'paused; after the clear it sends the answers put back', async () => {
  const sid = fresh()
  const from = { sent: sent.length, queued: queued.length }
  const res = await post('/api/http/run', { sheetId: sid, masterColumnName: 'Ask', config: config() })
  const id = res.body.runId as string
  await idle(sid)
  assert.deepEqual(pauseRun('http', id, uid), { ok: true })
  const h = await hold(sid)
  const resume = () => post(`/api/http/jobs/${id}/control`, { action: 'resume' })
  await refusedBoth(h, resume, [{ status: 409, body: { error: GOING } }, { status: 409, body: { error: BACK } }])
  assert.equal(db.prepare('SELECT status FROM http_runs WHERE id = ?').pluck().get(id), 'paused')
  await h.back()
  assert.deepEqual(await resume(), { status: 200, body: { message: 'HTTP run resumed' } })
  await work(from.queued)
  assert.deepEqual(sentSince(from.sent), OLD)
  assert.deepEqual(cells(sid, 'Got'), ['yes', 'yes'])
})

await ok('a resume of a paused run whose request reads its own output column, which it holds itself: not '
  + 'refused', async () => {
  const sid = sheet([{ Name: 'ada', Got: 'Old A' }, { Name: 'bob', Got: 'Old B' }], ['Name', 'Ask', 'Got'])
  const own = config()
  own.requestConfig.body = '{"before":"{{Got}}","name":"{{Name}}"}'
  const id = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,?,'paused','Ask')`).run(id, sid, uid, JSON.stringify(own))
  await seedProcessingPlaceholders({ run: { kind: 'http', id }, sheetId: sid, userId: uid, columns: ['Ask', 'Got'],
    targets: null, lastRow: 1, live: () => true })
  assert.equal(runHeldColumns(sid, uid, { clearing: true }).get('Got'), 'going', 'Got is held, by this run')
  const from = queued.length
  assert.deepEqual(await post(`/api/http/jobs/${id}/control`, { action: 'resume' }),
    { status: 200, body: { message: 'HTTP run resumed' } })
  assert.deepEqual(queued.slice(from).map(q => [q.job, q.args[0]]), [['HTTPRunJob', id]])
})

await ok('a preview reading a column a run holds, also one mapping it: refused, nothing sent; after the clear '
  + 'it sends the answers put back', async () => {
  const sid = fresh()
  const h = await hold(sid)
  const preview = () => post('/api/http/preview', { sheetId: sid, config: config() })
  // Mapping the column it reads doesn't make it the preview's own: a preview writes nothing.
  const mapping = [{ jsonPath: '$.ok', columnName: 'Answer' }]
  const mapsIt = () => post('/api/http/preview', { sheetId: sid, config: { ...config(), responseMapping: mapping } })
  const both = async () => [await preview(), await mapsIt()]
  const going = { status: 409, body: { error: GOING } }, back = { status: 409, body: { error: BACK } }
  await refusedBoth(h, both, [[going, going], [back, back]])
  await h.back()
  const from = sent.length
  const res = await preview()
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.deepEqual((res.body.previewResults as Array<{ status: string }>).map(r => r.status), ['success', 'success'])
  assert.deepEqual(sentSince(from), OLD)
})

server.close()
stand.close()
done()
