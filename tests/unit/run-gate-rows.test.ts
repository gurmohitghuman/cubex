// Over 200 lines: one stand-in (an API and OpenRouter) and the runs over it; split, each part would rebuild them.
// What a row waiting at the input gate keeps, and how it ends (services/run-input-gate.ts, run-gated-rows.ts):
//   - an AI row waits before its spend is admitted, so its hold is sized from the row it sends, not from the ⏳ it
//     was read with;
//   - a run's own end (here its provider brake) ends the wait: the rows that waited send nothing and stay ⏳, and
//     the run pauses at once instead of waiting for the hold to end;
//   - an AI run in a ring (a paused run fills what it reads and reads what it fills) fails its rows with the
//     ring's words through processRow and processMultiRow, more rows than the brake's count, and the brake
//     doesn't count them: the run completes, nothing called;
//   - a row deleted while it waits sends nothing and isn't counted; the others go on.
// HTTP requests go through Cubex's real outbound path to a stand-in (tests/e2e/net-shim.cjs); OpenRouter is the
// same stand-in, through the real SDK, with a priced model.
import assert from 'node:assert/strict'
import http from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
process.env.RUN_INPUT_WAIT_POLL_MS = '100'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// The stand-in. OpenRouter: one priced model; a call answers after `aiDelay`. /fail answers 500 after 300 ms and
// 100 ms more for each row ("i"); /ok answers {"ok": "yes"}. Every body is kept.
const MODEL = 'test/priced'
const sent: string[] = []
let aiDelay = 0, arrived = 0
const stand = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString()
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      const pricing = { prompt: '0.000001', completion: '0.000001' }
      res.end(JSON.stringify({ data: [{ id: MODEL, name: MODEL, pricing }] }))
      return
    }
    arrived++
    sent.push(body)
    if (req.url?.endsWith('/chat/completions')) {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'gen', object: 'chat.completion', created: 0, model: MODEL,
          choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.000002 } }))
      }, aiDelay)
      return
    }
    const fail = req.url?.endsWith('/fail')
    const wait = fail ? 300 + 100 * Number((JSON.parse(body) as { i: string }).i) : 0
    setTimeout(() => {
      res.writeHead(fail ? 500 : 200, { 'content-type': 'application/json' })
      res.end(fail ? '{"error":"down"}' : '{"ok":"yes"}')
    }, wait)
  })
})
await new Promise<void>(r => stand.listen(0, '127.0.0.1', r))
const port = (stand.address() as AddressInfo).port
process.env.E2E_RECEIVER_PORT = String(port)
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${port}/api/v1`
createRequire(import.meta.url)('../e2e/net-shim.cjs')
const API = `http://api.cubex-e2e.invalid:${port}`

const { undoKit } = await import('./run-undo-kit')
const { seedProcessingPlaceholders, PLACEHOLDER } = await import('../../server/src/lib/placeholder-cells')
const { processHTTPRun } = await import('../../server/src/services/http-runner')
const { processAIRun } = await import('../../server/src/services/ai-runner')
const { rowFixedOf } = await import('../../server/src/services/ai-spend-gate')
const { rowMaxMicro } = await import('../../server/src/lib/ai-spend-limit')
const { encrypt } = await import('../../server/src/lib/crypto')
const { db, uid, ok, done, sheet, cells } = undoKit('run-gate-rows')
console.error = () => {}
console.warn = () => {}
db.prepare('INSERT INTO settings (id, user_id, openrouter_api_key_encrypted) VALUES (?,?,?)')
  .run(uuid(), uid, encrypt('sk-or-test'))

const seed = (sid: string, kind: 'ai' | 'http', id: string, columns: string[], lastRow: number) =>
  seedProcessingPlaceholders({ run: { kind, id }, sheetId: sid, userId: uid, columns, targets: null, lastRow,
    live: () => true })
// A rerun of Answer going: its ⏳ in every row. finish() writes its answers and ends it.
async function hold(sid: string, rows: number) {
  const run = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,'{}','running','Answer')`).run(run, sid, uid)
  await seed(sid, 'http', run, ['Answer'], rows - 1)
  return {
    finish: (value: (i: number) => string) => db.transaction(() => {
      for (let i = 0; i < rows; i++) {
        db.prepare(`UPDATE rows SET data = json_set(data, '$.Answer', ?) WHERE sheet_id = ? AND row_index = ?`)
          .run(value(i), sid, i)
      }
      db.prepare(`UPDATE http_runs SET status = 'completed' WHERE id = ?`).run(run)
    }).immediate(),
  }
}
// An HTTP API run "Ask" posting {"a": "{{Answer}}", "i": "{{I}}"} to `path`, queued with its ⏳.
async function askRun(sid: string, path: string, rows: number, batchSize: number) {
  const id = uuid()
  const config = { requestConfig: { method: 'POST', url: `${API}${path}`,
    headers: { 'Content-Type': 'application/json' }, body: '{"a":"{{Answer}}","i":"{{I}}"}' },
  responseMapping: [], previewSize: 1, batchSize, retries: 0 }
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name,total_rows)
    VALUES (?,?,?,?,'pending','Ask',?)`).run(id, sid, uid, JSON.stringify(config), rows)
  await seed(sid, 'http', id, ['Ask'], rows - 1)
  return id
}
const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ I: String(i), Answer: `Old ${i}` }))
const httpRun = (id: string) => db.prepare('SELECT status, pause_reason, processed_rows FROM http_runs WHERE id = ?')
  .get(id) as { status: string; pause_reason: string | null; processed_rows: number }
const iSent = (from: number) => sent.slice(from).map(b => (JSON.parse(b) as { i: string }).i).sort()

await ok('an AI row waits before its spend is admitted: its hold is sized from the row it sends', async () => {
  const sid = sheet([{ Answer: 'Old' }], ['Answer', 'Hi'])
  const h = await hold(sid, 1)
  const id = uuid()
  db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,model,concurrency,status,total_rows,
    spend_limit_usd) VALUES (?,?,?,'Hi','Say /Answer',?,1,'pending',1,5)`).run(id, sid, uid, MODEL)
  await seed(sid, 'ai', id, ['Hi'], 0)
  aiDelay = 800
  const from = sent.length
  const going = processAIRun(id, 0)
  await sleep(600)
  assert.deepEqual(sent.slice(from), [], 'no call while Answer is held')
  const long = 'x'.repeat(20_000)
  h.finish(() => long)
  while (sent.length === from) await sleep(10)
  const held = db.prepare('SELECT hold_micro FROM ai_run_holds WHERE run_id = ?').pluck().get(id)
  const run = db.prepare('SELECT * FROM ai_runs WHERE id = ?').get(id) as never
  const most = rowMaxMicro({ prompt: 0.000001, completion: 0.000001, request: 0 }, rowFixedOf(run),
    Buffer.byteLength(`Say ${long}`))
  assert.equal(held, most)
  await going
  aiDelay = 0
})

await ok('the run\'s own brake ends the wait: the rows that waited send nothing and stay ⏳, the run pauses at once',
  async () => {
    const sid = sheet(rowsOf(8), ['I', 'Answer', 'Ask'])
    const id = await askRun(sid, '/fail', 8, 5)
    const from = sent.length, before = arrived
    const going = processHTTPRun(id, 0)
    while (arrived < before + 5) await sleep(5)
    const h = await hold(sid, 8)
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('the run never paused')), 4_000))
    await Promise.race([going, timeout])
    assert.deepEqual(httpRun(id).status, 'paused')
    assert.equal(httpRun(id).pause_reason, 'provider_errors')
    h.finish(i => `New ${i}`)
    await sleep(600)
    assert.deepEqual(iSent(from), ['0', '1', '2', '3', '4'], 'the rows that waited sent nothing')
    assert.deepEqual(cells(sid, 'Ask').slice(5), [PLACEHOLDER, PLACEHOLDER, PLACEHOLDER])
  })

// A paused HTTP API run on Answer reading `reads`: with the AI run reading /Answer, a ring.
function pausedHolder(sid: string, reads: string) {
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,?,'paused','Answer')`).run(uuid(), sid, uid, JSON.stringify({ requestConfig: { method: 'POST',
    url: `${API}/ok`, headers: {}, body: `{"x":"{{${reads}}}"}` }, responseMapping: [] }))
}
const ringWords = (mine: string) => `"${mine}" waits for "Answer" to finish filling, and "Answer" waits for `
  + `"${mine}": neither could finish, so this run, the newest, failed the rows that would wait. Run them again `
  + 'once "Answer" is filled.'
const aiRun = (id: string) => db.prepare('SELECT status, pause_reason FROM ai_runs WHERE id = ?').get(id)
const aiErrors = (id: string) => db.prepare(`SELECT status, error_message FROM ai_results WHERE run_id = ?
  ORDER BY row_index`).all(id) as Array<{ status: string; error_message: string }>

await ok('an AI run in a ring fails its rows through processRow, more of them than the brake counts, and the '
  + 'brake doesn\'t count them: the run completes, nothing called', async () => {
  const sid = sheet(rowsOf(7), ['I', 'Answer', 'Hi'])
  const id = uuid()
  db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,model,concurrency,status,total_rows)
    VALUES (?,?,?,'Hi','Say /Answer',?,2,'pending',7)`).run(id, sid, uid, MODEL)
  await seed(sid, 'ai', id, ['Hi'], 6)
  pausedHolder(sid, 'Hi')
  const from = sent.length
  await processAIRun(id, 0)
  assert.deepEqual(sent.slice(from), [])
  assert.deepEqual(aiErrors(id), Array(7).fill({ status: 'failed', error_message: ringWords('Hi') }))
  assert.deepEqual(aiRun(id), { status: 'completed', pause_reason: null })
})

await ok('a structured AI run in a ring fails its rows through processMultiRow the same way', async () => {
  const sid = sheet(rowsOf(7), ['I', 'Answer', 'Hi (Status)', 'City'])
  const id = uuid()
  const outputs = JSON.stringify([{ columnName: 'City', type: 'text', description: 'The city' }])
  db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,status_column,output_columns,prompt,model,
    concurrency,status,total_rows) VALUES (?,?,?,'Hi (Status)','Hi (Status)',?,'Say /Answer',?,2,'pending',7)`)
    .run(id, sid, uid, outputs, MODEL)
  await seed(sid, 'ai', id, ['Hi (Status)', 'City'], 6)
  pausedHolder(sid, 'City')
  const from = sent.length
  await processAIRun(id, 0)
  assert.deepEqual(sent.slice(from), [])
  assert.deepEqual(aiErrors(id), Array(7).fill({ status: 'failed', error_message: ringWords('City') }))
  assert.deepEqual(aiRun(id), { status: 'completed', pause_reason: null })
})

await ok('a row deleted while it waits sends nothing and isn\'t counted; the others go on', async () => {
  const sid = sheet(rowsOf(3), ['I', 'Answer', 'Ask'])
  const id = await askRun(sid, '/ok', 3, 1)
  const h = await hold(sid, 3)
  const from = sent.length
  const going = processHTTPRun(id, 0)
  await sleep(500)
  assert.deepEqual(sent.slice(from), [])
  db.prepare('DELETE FROM rows WHERE sheet_id = ? AND row_index = 1').run(sid)
  h.finish(i => `New ${i}`)
  await going
  assert.deepEqual(sent.slice(from).map(b => JSON.parse(b)), [{ a: 'New 0', i: '0' }, { a: 'New 2', i: '2' }])
  assert.deepEqual(httpRun(id), { status: 'completed', pause_reason: null, processed_rows: 2 })
})

stand.close()
done()
