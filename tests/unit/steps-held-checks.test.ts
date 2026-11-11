// Over 200 lines: the stand-ins, the app's route and the sheets serve every case; split, each would rebuild them.
// The other steps that read a column another run holds (going, or stopped and still putting its ⏳ cells back)
// wait or refuse instead of reading the ⏳:
//   - an AI run's resume runs its prompt check again: a held column answers 409 with the shared words, a column
//     deleted since 400 with the start's words; its own columns never count (lib/run-resume-inputs.ts);
//   - transfer_rows with move refuses while any column of the source rows is still being put back, copied or
//     not (the rows go to the trash whole), nothing moved; a copy leaving it out goes through;
//   - a setup's HTTP API and AI steps reading a held column wait, saying so, instead of failing the setup; a pause
//     and a stop meanwhile still work; once it's free they start (services/setup-runner.ts);
//   - a start whose "Only run if" rule reads a held column is refused (HTTP API, AI, an HTTP rerun);
//   - auto-run starts no run while a column its request reads is held; its rows stay queued.
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import express from 'express'
import cookieParser from 'cookie-parser'
import { v4 as uuid } from 'uuid'
import timeoutsMod from '../../server/src/lib/server-timeouts'
const { applyServerTimeouts } = timeoutsMod as typeof import('../../server/src/lib/server-timeouts')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

// OpenRouter's stand-in: one model, and an answer for any call.
const MODEL = 'test/model'
const stand = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(req.url?.endsWith('/models')
      ? JSON.stringify({ data: [{ id: MODEL, name: MODEL, pricing: { prompt: '0', completion: '0' } }] })
      : JSON.stringify({ id: 'gen', object: 'chat.completion', created: 0, model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 } }))
  })
})
await new Promise<void>(r => stand.listen(0, '127.0.0.1', r))
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(stand.address() as AddressInfo).port}/api/v1`

const { undoKit } = await import('./run-undo-kit')
const { signToken } = await import('../../server/src/lib/auth')
const { encrypt } = await import('../../server/src/lib/crypto')
const { seedProcessingPlaceholders } = await import('../../server/src/lib/placeholder-cells')
const { clearRunPlaceholders } = await import('../../server/src/lib/run-placeholders')
const { transferRows } = await import('../../server/src/services/rows-transfer')
const { startHttpRun } = await import('../../server/src/services/http-run-start')
const { rerunHttpColumn } = await import('../../server/src/services/http-run-rerun')
const { startAiRun } = await import('../../server/src/services/ai-run-start')
const { parseRunRequest } = await import('../../server/src/routes/ai-run-parse')
const { planApply } = await import('../../server/src/lib/setups/apply-plan')
const { sheetCandidates } = await import('../../server/src/services/setup-steps')
const { insertSetupRun, getSetupRun } = await import('../../server/src/services/setup-run-store')
const { advanceSetupRun } = await import('../../server/src/services/setup-runner')
const { controlSetupRun } = await import('../../server/src/services/setup-run-control')
const { saveAutorunSettings } = await import('../../server/src/services/autorun-settings')
const { autorunTick } = await import('../../server/src/services/autorun-loop')
const aiControl = (await import('../../server/src/routes/ai-control')).default
const { db, uid, ok, done, idle, sheet, cells } = undoKit('steps-held-checks')
console.error = () => {}
db.prepare('INSERT INTO settings (id, user_id, openrouter_api_key_encrypted) VALUES (?,?,?)')
  .run(uuid(), uid, encrypt('sk-or-test'))
// Starts and resumes queue a job: none runs here.
createRequire(path.resolve('server/src/queue.ts'))('sidequest').Sidequest.build = () => ({ enqueue: async () => ({}) })

const app = express()
app.use(cookieParser())
app.use(express.json())
app.use('/api/ai', aiControl)
const server = app.listen(0)
applyServerTimeouts(server)
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const cookie = `cubex_session=${signToken({ userId: uid, sessionEpoch: 0 })}`
const post = async (route: string, body: unknown) => {
  const res = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

const fresh = (columns = ['Name', 'Answer']) =>
  sheet([{ Name: 'ada', Answer: 'Old A' }, { Name: 'bob', Answer: 'Old B' }], columns)
// A rerun of `column` running, its ⏳ in the rows (all, or `targets`); stop() leaves it as a cancel does while its
// clear goes on, back() finishes the clear.
async function hold(sid: string, column = 'Answer', targets: number[] | null = null) {
  const run = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,'{}','running',?)`).run(run, sid, uid, column)
  await seedProcessingPlaceholders({ run: { kind: 'http', id: run }, sheetId: sid, userId: uid, columns: [column],
    targets, lastRow: 1, live: () => true })
  return {
    stop: () => db.prepare(`UPDATE http_runs SET status = 'cancelled', placeholder_work = 'clearing'
      WHERE id = ?`).run(run),
    back: () => clearRunPlaceholders('http', run),
  }
}
const words = (reader: string, column: string) => ({
  going: `${reader} reads "${column}", which a run that hasn't finished is still filling. `
    + 'Wait for that run to finish (or stop it), then try again.',
  back: `${reader} reads "${column}", which is getting back what it held before a stopped run. Try again in a moment.`,
})
const aiStatus = (id: string) => db.prepare('SELECT status FROM ai_runs WHERE id = ?').pluck().get(id)
const pausedAi = (sid: string, column: string, prompt: string) => {
  const id = uuid()
  db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,model,status) VALUES (?,?,?,?,?,?,'paused')`)
    .run(id, sid, uid, column, prompt, MODEL)
  return id
}

await ok('an AI run\'s resume (the app\'s route) reading a column a run holds: 409 with the words, it stays '
  + 'paused; after the clear it resumes', async () => {
  const sid = fresh(['Name', 'Answer', 'Hi'])
  const id = pausedAi(sid, 'Hi', 'Greet /Name about /Answer')
  const h = await hold(sid)
  const resume = () => post(`/api/ai/runs/${id}/resume`, {})
  const w = words('/Answer', 'Answer')
  assert.deepEqual(await resume(), { status: 409, body: { error: w.going } })
  h.stop()
  assert.deepEqual(await resume(), { status: 409, body: { error: w.back } })
  assert.equal(aiStatus(id), 'paused')
  await h.back()
  assert.deepEqual(await resume(), { status: 200, body: { message: 'AI run resumed' } })
})

await ok('an AI run\'s resume whose prompt names a column deleted since: 400 with the start\'s words; one reading '
  + 'its own column, which it holds itself, resumes', async () => {
  const sid = fresh(['Name', 'Hi'])
  const id = pausedAi(sid, 'Hi', 'Greet /Name about /Answer')
  assert.deepEqual(await post(`/api/ai/runs/${id}/resume`, {}), { status: 400, body: { error: 'Unknown column: '
    + '/Answer. Write a column as / and its name in lowercase with underscores ("Company Name" is /company_name); '
    + 'for a plain slash, put a space after it.' } })
  assert.equal(aiStatus(id), 'paused')
  const own = pausedAi(fresh(['Name', 'Answer']), 'Answer', 'Improve /Answer for /Name')
  assert.deepEqual(await post(`/api/ai/runs/${own}/resume`, {}), { status: 200, body: { message: 'AI run resumed' } })
})

await ok('transfer_rows with move while a column a copy leaves out is still being put back: refused, nothing moved '
  + 'or trashed; a copy leaving it out goes through; after the clear the move goes, without a ⏳', async () => {
  const sid = sheet([{ Name: 'ada', Answer: 'Old A', Extra: 'e1' }, { Name: 'bob', Answer: 'Old B', Extra: 'e2' }],
    ['Name', 'Answer', 'Extra'])
  const h = await hold(sid, 'Extra')
  const dest = sheet([], []), copies = sheet([], [])
  let key = 0
  const transfer = (to: string, operation: 'copy' | 'move') => transferRows(uid, { sourceSheetId: sid,
    destinationSheetId: to, operation, selection: { all: true }, columns: ['Name', 'Answer'],
    columnMode: 'create_missing', columnModeOmitted: false, columnMapping: {}, idempotencyKey: `move-${++key}` })
  const trash = () => db.prepare('SELECT COUNT(*) FROM trash_rows').pluck().get()
  assert.deepEqual(transfer(dest, 'move'), { fail: 'active_run',
    error: 'Cannot transfer rows while either sheet has an active run.' }, 'a run still going: sheet-wide')
  h.stop()
  const before = trash()
  assert.deepEqual(transfer(dest, 'move'), { fail: 'active_run',
    error: 'Column "Extra" is getting back what it held before a stopped run. Try again in a moment.' })
  assert.deepEqual(cells(sid, 'Name'), ['ada', 'bob'], 'nothing moved')
  assert.equal(trash(), before, 'nothing in the trash')
  const copied = transfer(copies, 'copy')
  assert.ok('ok' in copied && copied.ok.copied === 2, JSON.stringify(copied))
  await h.back()
  const moved = transfer(dest, 'move')
  assert.ok('ok' in moved && moved.ok.moved === 2, JSON.stringify(moved))
  const trashed = (db.prepare('SELECT data FROM trash_rows ORDER BY rowid DESC LIMIT 2').pluck().all() as string[])
    .map(d => JSON.parse(d).Extra).sort()
  assert.deepEqual(trashed, ['e1', 'e2'], 'the trash keeps what Extra held, not a ⏳')
})

// A setup with an HTTP API step and an AI step, both reading Answer.
const spec = {
  v: 1 as const, inputs: ['Name', 'Answer'], keys: [], steps: [
    { kind: 'http' as const, name: 'Ask', request: { method: 'POST' as const, url: 'https://api.example.com/ask',
      headers: {}, body: '{"a":"{{Answer}}"}', timeout: null }, mappings: [{ jsonPath: '$.ok', columnName: 'Got' }],
    batchSize: null, runIf: null, autoRun: null },
    { kind: 'ai' as const, name: 'Hi', prompt: 'Greet /Name about /Answer', systemPrompt: null, model: MODEL,
      temperature: 0.7, maxChars: null, concurrency: null, webSearch: false, webFetch: false, search: null,
      outputColumns: null, runIf: null },
  ],
}
function useSetup(sid: string): string {
  const plan = planApply(spec, ['Name', 'Answer'], {}, sheetCandidates(sid, uid))
  if (!('ok' in plan)) throw new Error(JSON.stringify(plan))
  return insertSetupRun({ userId: uid, sheetId: sid, setupId: null, setupName: 'Ask and greet',
    plan: { spec: plan.ok.spec, layers: plan.ok.layers, modes: plan.ok.modes }, targetRowIds: null,
    allowSecrets: true, autoRun: false })
}
const runsMade = (sid: string) => db.prepare(`SELECT (SELECT COUNT(*) FROM ai_runs WHERE sheet_id = ?)
  + (SELECT COUNT(*) FROM http_runs WHERE sheet_id = ? AND master_column_name <> 'Answer')`).pluck().get(sid, sid)
const stepsOf = (id: string) => getSetupRun(uid, id)!.steps.map(s => [s.state, s.note])
// Its sweep's rounds (a resume starts one of its own, which a round meanwhile leaves to it).
async function rounds(id: string) {
  for (let i = 0; i < 5; i++) { await advanceSetupRun(id); await new Promise(r => setTimeout(r, 20)) }
}

await ok('a setup whose HTTP API and AI steps read a column a run holds: both wait, saying so, the setup keeps '
  + 'running; a pause and a resume meanwhile start nothing; after the clear both start', async () => {
  const sid = fresh()
  const h = await hold(sid)
  const id = useSetup(sid)
  await advanceSetupRun(id)
  const going = 'Waits for "Answer", which a run that hasn\'t finished is still filling.'
  assert.equal(getSetupRun(uid, id)!.status, 'running')
  assert.deepEqual(stepsOf(id), [['waiting', going], ['waiting', going]])
  assert.ok('ok' in await controlSetupRun(uid, id, 'pause', true))
  h.stop()
  await advanceSetupRun(id)
  assert.equal(getSetupRun(uid, id)!.status, 'paused')
  assert.ok('ok' in await controlSetupRun(uid, id, 'resume', true))
  await rounds(id)
  const back = 'Waits for "Answer" to get back what it held before a stopped run.'
  assert.deepEqual(stepsOf(id), [['waiting', back], ['waiting', back]])
  assert.equal(runsMade(sid), 0, 'no run started while it waits')
  await h.back()
  await rounds(id)
  assert.deepEqual(stepsOf(id), [['running', null], ['running', null]])
  assert.equal(runsMade(sid), 2)
  await idle(sid)
})

await ok('a setup stopped while its step waits for a held column: it ends, and nothing starts after', async () => {
  const sid = fresh()
  const h = await hold(sid)
  const id = useSetup(sid)
  await advanceSetupRun(id)
  assert.ok('ok' in await controlSetupRun(uid, id, 'cancel', true))
  await h.back()
  await rounds(id)
  assert.equal(getSetupRun(uid, id)!.status, 'cancelled')
  assert.equal(runsMade(sid), 0)
})

await ok('a start whose "Only run if" reads a column a run holds is refused (an HTTP API start, an AI start, an '
  + 'HTTP API rerun), nothing made; after the clear each goes', async () => {
  const sid = fresh()
  const rule = '{{Answer}} is not empty'
  const http = (name: string) => startHttpRun(uid, { sheetId: sid, masterColumnName: name, allowSecrets: true,
    config: { requestConfig: { method: 'POST', url: 'https://api.example.com/x', headers: {},
      body: '{"n":"{{Name}}"}' },
      responseMapping: [{ jsonPath: '$.ok', columnName: `${name} got` }], previewSize: 2, runIf: rule } })
  const ai = () => startAiRun(uid, parseRunRequest({ sheetId: sid, columnName: 'Hi', prompt: 'Greet /Name',
    model: MODEL, runIf: rule }) as never)
  const first = await http('Push')
  assert.ok('ok' in first, JSON.stringify(first))
  await idle(sid)
  db.prepare("UPDATE http_runs SET status = 'completed' WHERE id = ?").run(first.ok.runId)
  const h = await hold(sid)
  const w = words('"Only run if"', 'Answer')
  const refused = (message: string, hold: string) => ({ fail: 'conflict', message, held: { column: 'Answer', hold } })
  // One at a time: each start holds the sheet while it seeds.
  const all = async () => {
    const out: unknown[] = []
    const rerun = () => rerunHttpColumn(uid, { sheetId: sid, masterColumnName: 'Push' })
    for (const start of [() => http('Ask'), ai, rerun]) {
      out.push(await start())
      await idle(sid)
    }
    return out
  }
  assert.deepEqual(await all(), [refused(w.going, 'going'), refused(w.going, 'going'), refused(w.going, 'going')])
  h.stop()
  const back = refused(w.back, 'clearing')
  assert.deepEqual(await all(), [back, back, back])
  assert.equal(runsMade(sid), 1, 'only the first run')
  await h.back()
  for (const out of await all()) assert.ok('ok' in out, JSON.stringify(out))
  await idle(sid)
})

await ok('auto-run starts no run while a column its request reads is held, its rows staying queued; once it\'s '
  + 'free the next tick starts one', async () => {
  const sid = fresh(['Name', 'Answer', 'Push'])
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name,allow_secrets)
    VALUES (?,?,?,?,'completed','Push',1)`).run(uuid(), sid, uid, JSON.stringify({ requestConfig: { method: 'POST',
    url: 'https://api.example.com/push', headers: {}, body: '{"a":"{{Answer}}"}' }, responseMapping: [] }))
  const on = await saveAutorunSettings(uid, sid, { column: 'Push', enabled: true, where: null, dailyCapUsd: null,
    dailyRowCap: null }, { hasSecretsScope: true })
  assert.ok('ok' in on, JSON.stringify(on))
  db.prepare(`INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,2,?)`)
    .run(uuid(), sid, uid, JSON.stringify({ Name: 'cy', Answer: 'C' }))
  const h = await hold(sid, 'Answer', [0, 1])
  const entry = db.prepare("SELECT id FROM autorun_columns WHERE sheet_id = ? AND status_column = 'Push'").pluck()
    .get(sid) as string
  const batches = () => db.prepare('SELECT COUNT(*) FROM http_runs WHERE autorun_id = ?').pluck().get(entry)
  await autorunTick(entry)
  assert.equal(batches(), 0, 'no run while Answer is held')
  h.stop()
  await autorunTick(entry)
  assert.equal(batches(), 0, 'nor while it is put back')
  await h.back()
  await autorunTick(entry)
  assert.equal(batches(), 1)
})

server.close()
stand.close()
done()
