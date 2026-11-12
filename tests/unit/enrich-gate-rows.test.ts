// Over 200 lines: the mock treg and the app's routes serve every case; split, each would start them again.
// Enrichment and waterfall rows at the input gate (services/run-input-gate.ts, run-gated-rows.ts):
//   - a row waiting for a column another run holds holds no spend: the gate comes before its money is sized and
//     held (enrich_holds), so it can't starve the run it waits for near a limit;
//   - in a ring (a paused run fills a column it reads and reads its status column), an enrichment fails its rows
//     with the ring's words and calls nothing; a waterfall does too, and leaves the run's tallies, its journal
//     and the answers the row kept for a retry as they were;
//   - a start whose "Only run if" (or an enrichment's older conditions) reads a held column is refused.
// treg is the repo's mock (tests/mock-treg), started here and stopped by its PID.
import assert from 'node:assert/strict'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import express from 'express'
import cookieParser from 'cookie-parser'
import { v4 as uuid } from 'uuid'
import timeoutsMod from '../../server/src/lib/server-timeouts'
const { applyServerTimeouts } = timeoutsMod as typeof import('../../server/src/lib/server-timeouts')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
process.env.RUN_INPUT_WAIT_POLL_MS = '100'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

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
const tregCalls = async () => ((await (await fetch(`${TREG}/__mock/requests`)).json()) as
  Array<{ path: string }>).filter(r => r.path.startsWith('/call/')).length

const { undoKit } = await import('./run-undo-kit')
const { signToken } = await import('../../server/src/lib/auth')
const { seedProcessingPlaceholders, PLACEHOLDER } = await import('../../server/src/lib/placeholder-cells')
const { clearRunPlaceholders } = await import('../../server/src/lib/run-placeholders')
const { processHTTPRun } = await import('../../server/src/services/http-runner')
const { saveTregToken } = await import('../../server/src/services/treg-key')
const { keepAnswer, findKeptAnswer } = await import('../../server/src/services/waterfall-journal')
const { keepForRetry, keptForRetry } = await import('../../server/src/services/waterfall-retry-kept')
const enrichRoutes = (await import('../../server/src/routes/enrich-runs')).default
const waterfallRoutes = (await import('../../server/src/routes/waterfall')).default
const { db, uid, ok, done, idle, sheet, cells } = undoKit('enrich-gate-rows')
console.error = () => {}
console.warn = () => {}
saveTregToken(uid, 'treg_mock_unit_team_key')

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
applyServerTimeouts(server)
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const cookie = `cubex_session=${signToken({ userId: uid, sessionEpoch: 0 })}`
const post = async (route: string, body: unknown) => {
  const res = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

// A work email lookup from Name and Website, into Email, at most $0.05 a row.
const enrichment = (over: Record<string, unknown> = {}) => ({
  toolId: 'treg.people.email.find', preset: null, columnName: 'Work email', continueColumn: false,
  inputs: { full_name: { column: 'Name' }, domain: { column: 'Website' } }, cleanDomains: false,
  providerOrder: [], skipProviders: [], stopAtFirst: false, email: null,
  outputs: [{ key: 'email', path: '$.output.email', columnName: 'Email' }], rows: { mode: 'all', test: false },
  conditions: [], maxCostPerRowUsd: 0.05, spendLimitUsd: null, fresh: true, ...over,
})
// A waterfall asking treg's finder for the email.
const waterfall = (over: Record<string, unknown> = {}) => ({
  columnName: 'Found', resultType: 'email', fresh: true,
  inputs: [{ key: 'full_name', label: 'Full name', source: { column: 'Name' } },
    { key: 'domain', label: 'Company domain', source: { column: 'Website' } }],
  steps: [{ label: 'treg finder', choices: { kind: 'enrichment', toolId: 'treg.people.email.find' } }], ...over,
})
const fresh = () => sheet([{ Name: 'Ada Lovelace', Website: 'a.example', Answer: 'x' },
  { Name: 'Bob Stone', Website: 'b.example', Answer: 'y' }], ['Name', 'Website', 'Answer'])
// A run going on `column`, its ⏳ in every row; finish() writes values and ends it, stop() and back() as a cancel.
async function hold(sid: string, column: string) {
  const run = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,'{}','running',?)`).run(run, sid, uid, column)
  await seedProcessingPlaceholders({ run: { kind: 'http', id: run }, sheetId: sid, userId: uid, columns: [column],
    targets: null, lastRow: 1, live: () => true })
  return {
    finish: () => db.transaction(() => {
      db.prepare(`UPDATE rows SET data = json_set(data, ?, row_index || '.example') WHERE sheet_id = ?`)
        .run(`$."${column}"`, sid)
      db.prepare(`UPDATE http_runs SET status = 'completed' WHERE id = ?`).run(run)
    })(),
    stop: () => db.prepare(`UPDATE http_runs SET status = 'cancelled', placeholder_work = 'clearing'
      WHERE id = ?`).run(run),
    back: () => clearRunPlaceholders('http', run),
  }
}
// A paused AI run filling Website and reading `prompt`'s column: with a run reading Website, a ring.
const pausedOnWebsite = (sid: string, prompt: string) => db.prepare(`INSERT INTO ai_runs
  (id,sheet_id,user_id,column_name,prompt,model,status) VALUES (?,?,?,'Website',?,'test/model','paused')`)
  .run(uuid(), sid, uid, prompt)
const heldMicro = (id: string) => db.prepare('SELECT IFNULL(SUM(hold_micro), 0) FROM enrich_holds WHERE run_id = ?')
  .pluck().get(id)
const results = (id: string) => db.prepare(`SELECT status, error_message FROM http_results WHERE run_id = ?
  ORDER BY row_index`).all(id)
const ring = (mine: string) => `"${mine}" waits for "Website" to finish filling, and "Website" waits for "${mine}": `
  + 'neither could finish, so this run, the newest, failed the rows that would wait. Run them again once '
  + '"Website" is filled.'
async function start(route: string, body: unknown, sid: string): Promise<string> {
  const res = await post(route, body)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  await idle(sid)
  return res.body.runId as string
}

await ok('an enrichment row waiting for a held column holds no spend; once it is free the row is held and called',
  async () => {
    const sid = fresh()
    const from = queued.length
    const id = await start(`/api/enrich/sheets/${sid}/runs`, enrichment(), sid)
    const h = await hold(sid, 'Website')
    const calls = await tregCalls()
    const going = work(from)
    await sleep(700)
    assert.equal(heldMicro(id), 0, 'no hold while it waits')
    assert.equal(await tregCalls(), calls)
    h.finish()
    await going
    assert.equal(await tregCalls(), calls + 2)
  })

await ok('a paid waterfall row waiting for a held column holds no spend', async () => {
  const sid = fresh()
  const from = queued.length
  const id = await start(`/api/waterfall/sheets/${sid}/runs`, waterfall(), sid)
  const h = await hold(sid, 'Website')
  const going = work(from)
  await sleep(700)
  assert.equal(heldMicro(id), 0, 'no hold while it waits')
  assert.deepEqual(cells(sid, 'Found'), [PLACEHOLDER, PLACEHOLDER])
  h.finish()
  await going
})

await ok('an enrichment in a ring fails its rows with the ring\'s words and calls nothing', async () => {
  const sid = fresh()
  const from = queued.length
  const id = await start(`/api/enrich/sheets/${sid}/runs`, enrichment(), sid)
  pausedOnWebsite(sid, 'Check /work_email')
  const calls = await tregCalls()
  await work(from)
  assert.equal(await tregCalls(), calls)
  assert.deepEqual(results(id), Array(2).fill({ status: 'failed', error_message: ring('Work email') }))
})

await ok('a waterfall in a ring fails its rows, leaving the run\'s tallies, its journal and the answers the row '
  + 'kept for a retry as they were', async () => {
  const sid = fresh()
  const from = queued.length
  const id = await start(`/api/waterfall/sheets/${sid}/runs`, waterfall(), sid)
  pausedOnWebsite(sid, 'Check /found')
  const stepId = (JSON.parse(db.prepare('SELECT config FROM http_runs WHERE id = ?').pluck().get(id) as string) as
    { waterfall: { steps: Array<{ id: string }> } }).waterfall.steps[0].id
  const rowId = db.prepare('SELECT id FROM rows WHERE sheet_id = ? AND row_index = 0').pluck().get(sid) as string
  const journal = { userId: uid, scope: id, rowRef: rowId, stepKey: 'k1' }
  keepAnswer(journal, id, { outcome: 'answered', value: 'v@a.example', costUsd: 0.01 } as never,
    { ai: false, keep: true })
  keepForRetry(uid, rowId, uuid(), [stepId],
    [{ stepId, stepKey: 'k2', kept: { outcome: 'not_found', value: '', costUsd: 0.02 } }])
  const calls = await tregCalls()
  await work(from)
  assert.equal(await tregCalls(), calls)
  assert.deepEqual(results(id), Array(2).fill({ status: 'failed', error_message: ring('Found') }))
  assert.equal(db.prepare('SELECT COUNT(*) FROM waterfall_step_tally WHERE run_id = ?').pluck().get(id), 0,
    'no step tallied')
  assert.ok(findKeptAnswer(journal), 'the journal kept')
  assert.ok(keptForRetry(uid, rowId, stepId, 'k2'), 'the kept outcome kept')
})

const RULE = '"Only run if" reads "Answer", which a run that hasn\'t finished is still filling. '
  + 'Wait for that run to finish (or stop it), then try again.'
const RULE_BACK = '"Only run if" reads "Answer", which is getting back what it held before a stopped run. '
  + 'Try again in a moment.'
await ok('an enrichment start whose "Only run if", or older conditions, read a held column is refused; a waterfall '
  + 'start\'s rule too; after the clear they start', async () => {
  const sid = fresh()
  const h = await hold(sid, 'Answer')
  const rule = enrichment({ runIf: '{{Answer}} is not empty' })
  const conditions = enrichment({ columnName: 'Work email 2', conditions: [{ column: 'Answer', op: 'not_empty',
    value: '' }], outputs: [{ key: 'email', path: '$.output.email', columnName: 'Email 2' }] })
  const wf = waterfall({ runIf: '{{Answer}} is not empty' })
  const all = async () => [await post(`/api/enrich/sheets/${sid}/runs`, rule),
    await post(`/api/enrich/sheets/${sid}/runs`, conditions), await post(`/api/waterfall/sheets/${sid}/runs`, wf)]
  const refused = (error: string) => Array(3).fill({ status: 409, body: { error } })
  assert.deepEqual(await all(), refused(RULE))
  h.stop()
  assert.deepEqual(await all(), refused(RULE_BACK))
  await h.back()
  for (const r of [rule, conditions]) await start(`/api/enrich/sheets/${sid}/runs`, r, sid)
  await start(`/api/waterfall/sheets/${sid}/runs`, wf, sid)
})

server.close()
treg.kill()
done()
