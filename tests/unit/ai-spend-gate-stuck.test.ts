// An AI run's spend limit when calls end without a cost (services/ai-spend-gate.ts,
// services/ai-row-outcome.ts) and when the database is busy, through the real
// SDK, row loop and writers against a stand-in for OpenRouter (ai-spend-kit.ts):
//   - a call whose answer broke off may be billed: its row's most stays held as
//     spent, and once that leaves no room the run pauses, saying so, instead of
//     waiting for good with nothing out;
//   - the SDK's "Request timed out." (sent, no answer) may be billed too; a
//     refusal OpenRouter answered, or a connection that never reached it, isn't;
//   - SQLITE_BUSY while a row asks for room makes it wait and ask again, not fail
//     the run;
//   - another user's hold on the same run id never counts.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import Database from 'better-sqlite3'
import { v4 as uuid } from 'uuid'
import { endsWithin, OUT, startStandIn, world } from './ai-spend-kit'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
// The SDK as the server loads it (CommonJS): its error classes are the ones the server checks against.
const sdk = createRequire(import.meta.url)('openai') as typeof import('openai')
const { APIConnectionError, APIConnectionTimeoutError, APIError } = sdk

const stand = await startStandIn()
const w = await world()
const { db, uid, ok, runOf, cells, runRow, holds, runById, PLACEHOLDER } = w
const { processAIRun } = await import('../../server/src/services/ai-runner')
const { rowFixedOf } = await import('../../server/src/services/ai-spend-gate')
const { rowMaxMicro } = await import('../../server/src/lib/ai-spend-limit')
const { processRow } = await import('../../server/src/services/ai-row')
const { callMayBeBilled } = await import('../../server/src/services/ai-row-outcome')
const { FailedCallError } = await import('../../server/src/services/ai-model-call')

// The most one of these rows can cost: "Say hi to N0" is 12 bytes.
const mostOf = (runId: string) =>
  rowMaxMicro({ prompt: 0.000001, completion: 0.000001, request: 0 }, rowFixedOf(runById(runId) as never), 12) / 1e6
const pauseByHand = (runId: string) => () =>
  db.prepare("UPDATE ai_runs SET status = 'paused' WHERE id = ?").run(runId)

await ok('a call whose answer broke off keeps its most as spent: the run pauses, never waits for good', async () => {
  stand.calls = 0
  stand.answer = n => (n === 1 ? 'cut' : 'ok')
  const { sid, runId } = runOf(3, 1, 1)
  const most = mostOf(runId)
  // Room for one row at its most and half another: after the cut-off call only spending could make room.
  db.prepare('UPDATE ai_runs SET spend_limit_usd = ? WHERE id = ?').run(most * 1.5, runId)
  await endsWithin(processAIRun(runId, 0), 15_000, pauseByHand(runId))
  const r = runRow(runId)
  assert.equal(stand.calls, 1, 'no row started after the cut-off call')
  assert.equal(r.status, 'paused')
  assert.equal(r.pause_reason, 'spend_limit')
  assert.match(r.error_message ?? '', /\(\$0\.00 spent\)\. Calls cut off before their answer came back may still be /)
  assert.match(r.error_message ?? '', /billed \(up to \$0\.00\d+\), so that counts as spent\. The next row could cost/)
  const c = cells(sid)
  assert.match(c[0], /^❌/)
  assert.deepEqual(c.slice(1), [PLACEHOLDER, PLACEHOLDER], 'the rows not started stay ⏳')
  assert.equal(holds(runId), 0, 'the worker dropped its hold')
  stand.answer = () => 'ok'
})

await ok('the SDK\'s "Request timed out." may be billed (the failed row says so); a refusal is not', async () => {
  const { runId } = runOf(1, 1, 1)
  db.prepare("UPDATE ai_runs SET status = 'running' WHERE id = ?").run(runId)
  const run = runById(runId) as never
  const quick = new sdk.OpenAI({
    apiKey: 'sk-or-test', baseURL: process.env.OPENROUTER_BASE_URL, maxRetries: 0, timeout: 300,
  })
  stand.delayMs = 1_000
  const outcome = await processRow(runId, { rowIndex: 0, data: { name: 'N0' } }, run, quick, undefined, 0)
  stand.delayMs = 50
  assert.equal(outcome.kind, 'failed')
  assert.ok(outcome.kind === 'failed' && outcome.message.startsWith('Request timed out.'), JSON.stringify(outcome))
  assert.equal(outcome.kind === 'failed' && outcome.maybeBilled, true)

  const sent = { sent: true, call: null }
  assert.equal(callMayBeBilled(new APIConnectionTimeoutError(), sent), true)
  assert.equal(callMayBeBilled(new APIConnectionError({ cause: Object.assign(new Error('x'), { code: 'EPIPE' }) }),
    sent), true, 'a connection lost after the call went out')
  assert.equal(callMayBeBilled(new TypeError('invalid json response body'), sent), true)
  assert.equal(callMayBeBilled(new APIConnectionTimeoutError(), { sent: false, call: null }), false, 'never sent')
  const stale = new APIConnectionError({ cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) })
  assert.equal(callMayBeBilled(stale, sent), false, 'the stale keep-alive socket: it died on the wire')
  assert.equal(callMayBeBilled(new APIError(402, undefined, 'No credits', undefined), sent), false, 'refused')
  assert.equal(callMayBeBilled(new APIError(500, undefined, 'Upstream', undefined), sent), false)
  assert.equal(callMayBeBilled(new FailedCallError('failed', {} as never), sent), false, 'its cost came back')
  assert.equal(callMayBeBilled(new Error('no usable content'), { sent: true, call: {} as never }), false)
})

await ok('SQLITE_BUSY while a row asks for room: it waits and asks again, and the run finishes', async () => {
  stand.calls = 0
  const cost = stand.costUsd
  stand.costUsd = 0.0001
  const { sid, runId } = runOf(2, 2, 1)
  const most = mostOf(runId)
  // One row at a time: the second waits for the first's hold, asking again and again.
  db.prepare('UPDATE ai_runs SET spend_limit_usd = ? WHERE id = ?').run(most * 1.5, runId)
  // While the first call is out another connection holds the write lock past busy_timeout (5 s), then lets go.
  const other = new Database(process.env.DB_PATH!)
  stand.answer = n => {
    if (n !== 1) return 'ok'
    other.prepare('BEGIN IMMEDIATE').run()
    setTimeout(() => other.prepare('COMMIT').run(), 6_500)
    return new Promise<void>(resolve => setTimeout(resolve, 7_000))
  }
  await endsWithin(processAIRun(runId, 0), 40_000, pauseByHand(runId))
  other.close()
  stand.answer = () => 'ok'
  stand.costUsd = cost
  const r = runRow(runId)
  assert.equal(r.status, 'completed', `${r.status}: ${r.error_message}`)
  assert.deepEqual(cells(sid), ['Hello', 'Hello'])
  assert.equal(stand.calls, 2)
})

await ok("another user's hold on the same run id never counts", async () => {
  const other = uuid()
  db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(other, 'x')
  const { sid, runId } = runOf(2, 2, 0.05)
  db.prepare(`INSERT INTO ai_run_holds (run_id, worker_generation, user_id, hold_micro) VALUES (?, 0, ?, 50000)`)
    .run(runId, other)
  db.prepare('UPDATE ai_runs SET worker_generation = 1 WHERE id = ? AND user_id = ?').run(runId, uid)
  await endsWithin(processAIRun(runId, 1), 10_000, pauseByHand(runId))
  assert.equal(runRow(runId).status, 'completed')
  assert.deepEqual(cells(sid), ['Hello', 'Hello'])
  assert.equal(holds(runId), 1, "the other user's row is left alone")
})

stand.close()
w.done()
void OUT
