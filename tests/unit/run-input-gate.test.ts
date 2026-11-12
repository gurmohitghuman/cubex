// Over 200 lines: one stand-in (an API and OpenRouter) and the runs over it; split, each part would rebuild them.
// A running row waits for the columns it reads (services/run-input-gate.ts). A run already going reads a column
// another run starts to fill (or a stopped one is putting back): the rows it hasn't reached wait, keeping their
// slot, and send nothing while the column is held; then each reads its row again and sends the value that run
// left. A pause during the wait leaves the rows ⏳ for their run, and its resume is refused while the hold lasts.
// Runs that would wait for each other in a ring end: each row that would wait fails, naming the columns. An AI
// run's rows wait the same way. HTTP requests go through Cubex's real outbound path to a stand-in
// (tests/e2e/net-shim.cjs); OpenRouter is the same stand-in, reached through the real SDK.
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
// A run that parks is picked up again soon (lib/run-park.ts): read before the server's modules load.
process.env.RUN_PARK_MS = '200'
process.env.SIDEQUEST_POLL_MS = '50'

// The stand-in: the API keeps each request's body and answers {"ok": "yes"} after `delayMs`; OpenRouter lists one
// model and keeps each prompt.
const sent: string[] = []
let delayMs = 0, arrived = 0
const MODEL = 'test/model'
const stand = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString()
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url?.endsWith('/models')) {
      res.end(JSON.stringify({ data: [{ id: MODEL, name: MODEL, pricing: { prompt: '0', completion: '0' } }] }))
      return
    }
    if (req.url?.endsWith('/chat/completions')) {
      const messages = (JSON.parse(body) as { messages: Array<{ content: string }> }).messages
      sent.push(`ai: ${messages[messages.length - 1].content}`)
      res.end(JSON.stringify({ id: 'gen', object: 'chat.completion', created: 0, model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 } }))
      return
    }
    arrived++
    setTimeout(() => { sent.push(body); res.end('{"ok":"yes"}') }, delayMs)
  })
})
await new Promise<void>(r => stand.listen(0, '127.0.0.1', r))
const port = (stand.address() as AddressInfo).port
process.env.E2E_RECEIVER_PORT = String(port)
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${port}/api/v1`
createRequire(import.meta.url)('../e2e/net-shim.cjs')

const { undoKit } = await import('./run-undo-kit')
const { seedProcessingPlaceholders, PLACEHOLDER } = await import('../../server/src/lib/placeholder-cells')
const { clearRunPlaceholders } = await import('../../server/src/lib/run-placeholders')
const { processHTTPRun } = await import('../../server/src/services/http-runner')
const { processAIRun } = await import('../../server/src/services/ai-runner')
const { pauseRun, resumeRun } = await import('../../server/src/services/run-lifecycle')
const { encrypt } = await import('../../server/src/lib/crypto')
const { db, uid, ok, done, sheet, cells } = undoKit('run-input-gate')
console.error = () => {}
// A resume queues a job: the worker is called directly below instead.
createRequire(path.resolve('server/src/queue.ts'))('sidequest').Sidequest.build = () => ({ enqueue: async () => ({}) })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
db.prepare('INSERT INTO settings (id, user_id, openrouter_api_key_encrypted) VALUES (?,?,?)')
  .run(uuid(), uid, encrypt('sk-or-test'))

// Ask's request reads {{Answer}} and {{Name}}; it writes Got. One row at a time.
const URL_ = `http://api.cubex-e2e.invalid:${port}/ask`
const config = () => ({
  requestConfig: { method: 'POST', url: URL_, headers: { 'Content-Type': 'application/json' },
    body: '{"answer":"{{Answer}}","name":"{{Name}}"}' },
  responseMapping: [{ jsonPath: '$.ok', columnName: 'Got' }], previewSize: 2, batchSize: 1,
})
const COLUMNS = ['Name', 'Answer', 'Ask', 'Got']
const fresh = () => sheet([{ Name: 'ada', Answer: 'Old A' }, { Name: 'bob', Answer: 'Old B' },
  { Name: 'cy', Answer: 'Old C' }], COLUMNS)
const seed = (sid: string, kind: 'ai' | 'http', id: string, columns: string[]) => seedProcessingPlaceholders({
  run: { kind, id }, sheetId: sid, userId: uid, columns, targets: null, lastRow: 2, live: () => true })
// Ask's run, queued with its ⏳ seeded as a start leaves it.
async function askRun(sid: string) {
  const id = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name,total_rows)
    VALUES (?,?,?,?,'pending','Ask',3)`).run(id, sid, uid, JSON.stringify(config()))
  await seed(sid, 'http', id, ['Ask', 'Got'])
  return id
}
// A rerun of Answer starting: its ⏳ in every row. finish() writes its answers and ends it; stop() leaves it as a
// cancel does while its clear goes on, back() finishes the clear.
async function hold(sid: string) {
  const run = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,'{}','running','Answer')`).run(run, sid, uid)
  await seed(sid, 'http', run, ['Answer'])
  return {
    finish: (values: string[]) => db.transaction(() => {
      values.forEach((v, i) => db.prepare(`UPDATE rows SET data = json_set(data, '$.Answer', ?)
        WHERE sheet_id = ? AND row_index = ?`).run(v, sid, i))
      db.prepare(`UPDATE http_runs SET status = 'completed' WHERE id = ?`).run(run)
    }).immediate(),
    stop: () => db.prepare(`UPDATE http_runs SET status = 'cancelled', placeholder_work = 'clearing'
      WHERE id = ?`).run(run),
    back: () => clearRunPlaceholders('http', run),
  }
}
const statusOf = (id: string) => db.prepare('SELECT status FROM http_runs WHERE id = ?').pluck().get(id)
const errors = (id: string) => db.prepare('SELECT error_message FROM http_results WHERE run_id = ? ORDER BY row_index')
  .pluck().all(id)
const body = (answer: string, name: string) => JSON.stringify({ answer, name })
// The first row goes out (slowly), Answer is taken meanwhile: the rows read with it are already in memory.
async function midRun(sid: string, id: string) {
  delayMs = 400
  const from = sent.length, before = arrived
  const going = processHTTPRun(id, 0)
  while (arrived === before) await sleep(5)
  const h = await hold(sid)
  await sleep(1600)
  delayMs = 0
  assert.deepEqual(sent.slice(from), [body('Old A', 'ada')], 'only the row sent before the hold')
  assert.deepEqual(cells(sid, 'Ask').slice(1), [PLACEHOLDER, PLACEHOLDER], 'the rest wait, ⏳')
  assert.equal(statusOf(id), 'running')
  return { h, going, from }
}

await ok('a running HTTP API run whose request reads a column a later run fills: its rows wait, nothing is sent '
  + 'while it is held, then each sends the value that run wrote', async () => {
  const sid = fresh()
  const id = await askRun(sid)
  const { h, going, from } = await midRun(sid, id)
  h.finish(['New A', 'New B', 'New C'])
  await going
  assert.deepEqual(sent.slice(from), [body('Old A', 'ada'), body('New B', 'bob'), body('New C', 'cy')])
  assert.deepEqual(cells(sid, 'Got'), ['yes', 'yes', 'yes'])
  assert.equal(statusOf(id), 'completed')
})

await ok('a column a stopped run is still putting back: the rows wait for the clear, then send what it put back',
  async () => {
    const sid = fresh()
    const id = await askRun(sid)
    const { h, going, from } = await midRun(sid, id)
    h.stop()
    await sleep(1200)
    assert.deepEqual(sent.slice(from), [body('Old A', 'ada')], 'still waiting while the clear goes on')
    await h.back()
    assert.deepEqual(cells(sid, 'Answer'), ['Old A', 'Old B', 'Old C'])
    await going
    assert.deepEqual(sent.slice(from), [body('Old A', 'ada'), body('Old B', 'bob'), body('Old C', 'cy')])
  })

await ok('a pause during the wait: the run stops with its rows ⏳ and nothing sent; its resume is refused while '
  + 'the hold lasts, and after it the rows send the new values', async () => {
  const sid = fresh()
  const id = await askRun(sid)
  const { h, going, from } = await midRun(sid, id)
  assert.deepEqual(pauseRun('http', id, uid), { ok: true })
  await going
  assert.deepEqual(sent.slice(from), [body('Old A', 'ada')])
  assert.deepEqual(cells(sid, 'Ask').slice(1), [PLACEHOLDER, PLACEHOLDER])
  assert.equal(statusOf(id), 'paused')
  assert.deepEqual(await resumeRun('http', id, uid, true), { fail: 'held', message: 'The request reads "Answer", '
    + 'which a run that hasn\'t finished is still filling. Wait for that run to finish (or stop it), then try again.' })
  h.finish(['New A', 'New B', 'New C'])
  assert.deepEqual(await resumeRun('http', id, uid, true), { ok: true })
  await processHTTPRun(id, 1)
  assert.deepEqual(sent.slice(from), [body('Old A', 'ada'), body('New B', 'bob'), body('New C', 'cy')])
})

const RING = '"Got" waits for "Answer" to finish filling, and "Answer" waits for "Got": neither could finish, so '
  + 'this run, the newest, failed the rows that would wait. Run them again once "Answer" is filled.'
await ok('a run whose request reads a column filled by a paused AI run that reads its own column: a ring, so its '
  + 'rows fail naming both columns, nothing is sent, and the run ends', async () => {
  const sid = fresh()
  const id = await askRun(sid)
  const ai = uuid()
  db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,model,status)
    VALUES (?,?,?,'Answer','Improve /Got',?,'paused')`).run(ai, sid, uid, MODEL)
  const from = sent.length
  await processHTTPRun(id, 0)
  assert.deepEqual(sent.slice(from), [])
  assert.deepEqual(errors(id), [RING, RING, RING])
  assert.equal(statusOf(id), 'completed')
})

await ok('two running HTTP API runs whose requests read each other\'s columns: both end, and no request carries a ⏳',
  async () => {
    const sid = fresh()
    const ask = await askRun(sid)
    const other = uuid()
    const reads = { ...config(), requestConfig: { ...config().requestConfig, body: '{"got":"{{Got}}"}' },
      responseMapping: [] }
    db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name,total_rows)
      VALUES (?,?,?,?,'pending','Answer',3)`).run(other, sid, uid, JSON.stringify(reads))
    await seed(sid, 'http', other, ['Answer'])
    const from = sent.length
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('the runs never ended')), 15_000))
    // A run that parks is run again after its delay, as its snoozed job would be.
    const toEnd = async (id: string) => {
      for (let parked = await processHTTPRun(id, 0); parked; parked = await processHTTPRun(id, 0)) {
        await sleep(parked.parkMs)
      }
    }
    await Promise.race([Promise.all([toEnd(ask), toEnd(other)]), timeout])
    assert.ok(!['pending', 'running'].includes(statusOf(ask) as string), `Ask is ${statusOf(ask)}`)
    assert.ok(!['pending', 'running'].includes(statusOf(other) as string), `the other is ${statusOf(other)}`)
    assert.ok(sent.slice(from).every(b => !b.includes('⏳')), JSON.stringify(sent.slice(from)))
  })

await ok('a running AI run whose prompt reads a column a later run fills: its rows wait, no call while it is held, '
  + 'then each prompt carries the new value', async () => {
  const sid = sheet([{ Name: 'ada', Answer: 'Old A' }, { Name: 'bob', Answer: 'Old B' }], ['Name', 'Answer', 'Hi'])
  const ai = uuid()
  db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,model,concurrency,status,total_rows)
    VALUES (?,?,?,'Hi','Greet /Name about /Answer',?,1,'pending',2)`).run(ai, sid, uid, MODEL)
  await seedProcessingPlaceholders({ run: { kind: 'ai', id: ai }, sheetId: sid, userId: uid, columns: ['Hi'],
    targets: null, lastRow: 1, live: () => true })
  const h = await hold(sid)
  const from = sent.length
  const going = processAIRun(ai, 0)
  await sleep(1600)
  assert.deepEqual(sent.slice(from), [], 'no call while Answer is held')
  assert.deepEqual(cells(sid, 'Hi'), [PLACEHOLDER, PLACEHOLDER])
  h.finish(['New A', 'New B'])
  await going
  assert.deepEqual(sent.slice(from), ['ai: Greet ada about New A', 'ai: Greet bob about New B'])
  assert.deepEqual(cells(sid, 'Hi'), ['Hi', 'Hi'])
})

stand.close()
done()
