// A run someone started waits out a short outage before its brake pauses it (lib/run-brake-waits.ts), and a
// failure on the account's side pauses it at once (lib/run-breaker.ts). Through the real AI worker loop against a
// stand-in for OpenRouter on 127.0.0.1: an outage that ends during the first wait leaves the run finishing; one that
// doesn't pauses it after its waits, saying so; a refused key pauses it after one row; a pause during a wait ends it.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { passed } from './ends-on-its-own'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
process.env.RUN_BREAKER_FAILURES = '2'
process.env.RUN_BREAKER_WAITS = '2'
process.env.RUN_BREAKER_WAIT_MS = '300'   // waits of 0.3 s and 1.2 s

// failLeft: how many calls fail with a 500 before they answer; key: every call says the key is refused.
let failLeft = 0, key = false, calls = 0
const server = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return
    }
    calls++
    if (key) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'No auth credentials found', code: 401 } }))
      return
    }
    if (failLeft > 0) {
      failLeft--
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Internal server error', code: 500 } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: 'gen-1', object: 'chat.completion', created: 0, model: 'test/model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, cost: 0.0001 },
    }))
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`

const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { encrypt } = await import('../../server/src/lib/crypto')
const { processAIRun } = await import('../../server/src/services/ai-runner')
const { PLACEHOLDER } = await import('../../server/src/lib/placeholder-cells')
const { BrakeWaits } = await import('../../server/src/lib/run-brake-waits')
const { RunBreaker, httpAccountSide, aiAccountError, fixedTarget } = await import('../../server/src/lib/run-breaker')
runMigrations()
console.warn = () => {}
console.error = () => {}

const uid = uuid(), tid = uuid(), OUT = 'Hi (Output)'
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO settings (id, user_id, openrouter_api_key_encrypted) VALUES (?,?,?)')
  .run(uuid(), uid, encrypt('sk-or-test'))
const runOf = (n: number, concurrency = 1) => {
  const sid = uuid(), runId = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)')
    .run(sid, tid, uid, `S-${sid.slice(0, 6)}`, JSON.stringify(['name', OUT]))
  for (let i = 0; i < n; i++) {
    db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
      .run(uuid(), sid, uid, i, JSON.stringify({ name: `N${i}`, [OUT]: PLACEHOLDER }))
  }
  db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, concurrency, status, total_rows)
    VALUES (?,?,?,?,'Say hi to /name','test/model',?,'pending',?)`).run(runId, sid, uid, OUT, concurrency, n)
  return { sid, runId }
}
const cells = (sid: string) => db.prepare(`SELECT json_extract(data, ?) FROM rows WHERE sheet_id = ?
  ORDER BY row_index`).pluck().all(`$."${OUT}"`, sid) as string[]
const runRow = (id: string) => db.prepare('SELECT status, pause_reason, error_message FROM ai_runs WHERE id = ?')
  .get(id) as { status: string; pause_reason: string | null; error_message: string | null }

// An outage that ends during the first wait: two rows fail, the run waits 0.3 s, and the rest answer.
{
  failLeft = 2; calls = 0
  const { sid, runId } = runOf(6)
  const t = Date.now()
  await processAIRun(runId, 0)
  assert.ok(Date.now() - t >= 300, 'it waited')
  assert.equal(runRow(runId).status, 'completed')
  assert.equal(cells(sid).filter(v => v === 'Hello').length, 4)
  assert.equal(cells(sid).filter(v => v.startsWith('❌')).length, 2)
  console.log('ok   a short outage: the run waits, then goes on and finishes')
}

// One that doesn't end: two rows fail, a wait, two more, a longer wait, two more, then the pause says so.
{
  failLeft = 1_000; calls = 0
  const { sid, runId } = runOf(10)
  await processAIRun(runId, 0)
  const r = runRow(runId)
  assert.equal(r.status, 'paused')
  assert.equal(r.pause_reason, 'provider_errors')
  assert.match(r.error_message ?? '',
    /^2 rows in a row failed on the provider's side, even after waiting 0\.3 s and 1\.2 s, so the run paused/)
  assert.equal(calls, 6)
  assert.equal(cells(sid).filter(v => v === PLACEHOLDER).length, 4, 'the rows not run stay ⏳')
  console.log('ok   an outage that goes on: two waits, then the pause says it waited')
}

// Rows out together when the brake trips fail into its wait and don't count toward the next: 4 at a time, every row
// failing, still sits out both waits (0.3 s and 1.2 s) before it pauses.
{
  failLeft = 1_000; calls = 0
  const { sid, runId } = runOf(20, 4)
  const t = Date.now()
  await processAIRun(runId, 0)
  const r = runRow(runId)
  assert.ok(Date.now() - t >= 1_500, `waited ${Date.now() - t} ms`)
  assert.equal(r.status, 'paused')
  assert.match(r.error_message ?? '', /even after waiting 0\.3 s and 1\.2 s/)
  assert.ok(cells(sid).filter(v => v === PLACEHOLDER).length > 0, `${calls} calls: rows left waiting`)
  console.log('ok   rows out together fail into the wait: a burst still sits out every wait')
}

// No rows left when the brake trips: the run ends without waiting.
{
  failLeft = 1_000; calls = 0
  const { sid, runId } = runOf(2, 2)
  const t = Date.now()
  await processAIRun(runId, 0)
  assert.ok(Date.now() - t < 280, `took ${Date.now() - t} ms`)
  assert.equal(runRow(runId).status, 'completed')
  assert.equal(cells(sid).filter(v => v.startsWith('❌')).length, 2)
  console.log('ok   with no rows left a run never waits')
}

// A refused key: the first row's failure pauses the run, with no wait.
{
  failLeft = 0; key = true; calls = 0
  const { sid, runId } = runOf(5)
  const t = Date.now()
  await processAIRun(runId, 0)
  const r = runRow(runId)
  assert.equal(r.status, 'paused')
  assert.match(r.error_message ?? '', /^The provider refused the account or its key, so the run paused/)
  assert.equal(calls, 1)
  assert.ok(Date.now() - t < 2_000, 'no wait')
  assert.equal(cells(sid).filter(v => v === PLACEHOLDER).length, 4)
  key = false
  console.log('ok   a refused key pauses the run after one row, without waiting')
}

// A pause (or any stop) during a wait ends it at once.
{
  const waits = new BrakeWaits(1, 60_000)
  assert.ok(waits.begin(new RunBreaker(2)) && waits.waiting)
  const t = Date.now()
  let stop = false
  setTimeout(() => { stop = true }, 100)
  await waits.sit(() => undefined, () => stop)
  assert.ok(Date.now() - t < 2_000 && !waits.waiting)
  assert.equal(waits.begin(new RunBreaker(2)), false, 'none left')
  console.log('ok   a stop ends a wait; no more waits than allowed')
}

// Which failures are the account's, by the status answered, never by the words (a row's text or a page can say 403):
// OpenRouter's 401 and 402 (not its in-flight budget); an HTTP API's 401 and 407 when host and headers are fixed.
assert.ok(aiAccountError({ status: 401 }, '401 No auth credentials found'))
assert.ok(aiAccountError({ status: 402 }, '402 Insufficient credits'))
const inFlight = '402 Too many requests in flight (in_flight_budget_exhausted)'
assert.ok(!aiAccountError({ status: 402 }, inFlight), 'its in-flight budget frees up')
assert.ok(!aiAccountError({ status: 403 }, '403 Your input was flagged'), 'a refusal about this row')
assert.ok(!aiAccountError(new Error('its reply began: "403 Forbidden"'), 'its reply began: "403 Forbidden"'))
assert.ok(!aiAccountError({ status: 500 }, '500 Internal server error'))
const status = (n: number) => ({ kind: 'status', status: n }) as never
assert.ok(httpAccountSide(status(401), true) && httpAccountSide(status(407), true))
assert.ok(!httpAccountSide(status(401), false), 'a host or header from the row: about that row')
assert.ok(!httpAccountSide(status(403), true) && !httpAccountSide({ kind: 'network' } as never, true))
assert.ok(fixedTarget({ url: 'https://api.example.com/v1/people/{{id}}?q={{name}}', headers: { 'X-Key': '/my_key' } }))
assert.ok(!fixedTarget({ url: 'https://{{website}}/about' }) && !fixedTarget({ url: '{{url}}' }))
assert.ok(!fixedTarget({ url: 'https://api.example.com', headers: { Authorization: 'Bearer {{token}}' } }))
console.log('ok   the account\'s side: by status; HTTP 401 and 407 only on a fixed host and headers')

server.close()
console.log('run-brake-waits: all assertions passed')
passed()
