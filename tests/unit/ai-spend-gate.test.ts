// Over 200 lines: one stand-in and the runs over it; split, each part would rebuild them.
// An AI run's hard spend limit in its worker (services/ai-spend-gate.ts),
// against a stand-in for OpenRouter on 127.0.0.1 (its model list with prices
// and a chat endpoint that bills each call), through the real SDK, row loop
// and writers on a migrated throwaway DB:
//   - several rows out at once: the run never spends past its limit, uses the
//     room it has, and pauses (pause_reason spend_limit, the rest ⏳) once
//     what is left can't cover the next row's most;
//   - a resume with a higher limit (services/ai-run-limit.ts) finishes it; one
//     at a limit already spent is refused and changes nothing;
//   - rows an earlier worker of the run still has out (its hold) are waited
//     for; a hold older than any call can be is not;
//   - a model with no listed price stops on what was billed;
//   - a row whose call may be billed moves its most from the hold to the run's cut-off total, counted as
//     spent (ai-spend-gate-stuck.test.ts: what the run does then; ai-spend-resume.test.ts: after a resume);
//   - a run without a limit holds nothing; boot drops every hold.
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

// --- The stand-in -----------------------------------------------------------------
const PRICED = 'test/priced'
let costUsd = 0.005
let delayMs = 120
let calls = 0, inflight = 0, mostInflight = 0
const server = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      const pricing = { prompt: '0.000001', completion: '0.000001' }
      res.end(JSON.stringify({ data: [{ id: PRICED, name: PRICED, pricing }] }))
      return
    }
    calls++
    inflight++
    mostInflight = Math.max(mostInflight, inflight)
    setTimeout(() => {
      inflight--
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: `gen-${calls}`, object: 'chat.completion', created: 0, model: PRICED,
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, cost: costUsd },
      }))
    }, delayMs)
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`

const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { encrypt } = await import('../../server/src/lib/crypto')
const { processAIRun } = await import('../../server/src/services/ai-runner')
const { resumeAiRun } = await import('../../server/src/services/ai-run-limit')
const { runSpentUsd, rowFixedOf, openSpendGate } = await import('../../server/src/services/ai-spend-gate')
const { AI_TIMEOUT_MESSAGE, failedRow } = await import('../../server/src/services/ai-row-outcome')
const { rowMaxMicro } = await import('../../server/src/lib/ai-spend-limit')
const { getAiRunSummary } = await import('../../server/src/services/run-status')
const { resetOrphanedRuns } = await import('../../server/src/lib/orphan-runs')
const { PLACEHOLDER } = await import('../../server/src/lib/placeholder-cells')
runMigrations()
console.warn = () => {}
console.error = () => {}
// Only this test's own lines: the runner's logs stay out.
const log = console.log
console.log = (...a: unknown[]) => {
  if (typeof a[0] === 'string' && /^(ok|FAIL)/.test(a[0])) log(...a)
}
// Resuming queues a job: the worker is called directly below instead.
createRequire(path.resolve('server/src/queue.ts'))('sidequest').Sidequest.build = () => ({ enqueue: async () => ({}) })

let failures = 0
const ok = async (label: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO settings (id, user_id, openrouter_api_key_encrypted) VALUES (?,?,?)')
  .run(uuid(), uid, encrypt('sk-or-test'))

const OUT = 'Hi (Output)'
// A sheet of `n` rows waiting on a run (their output cell ⏳), and that run.
function runOf(n: number, concurrency: number, limit: number | null, model = PRICED) {
  const sid = uuid(), runId = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)')
    .run(sid, tid, uid, `S-${sid.slice(0, 6)}`, JSON.stringify(['name', OUT]))
  for (let i = 0; i < n; i++) {
    db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
      .run(uuid(), sid, uid, i, JSON.stringify({ name: `N${i}`, [OUT]: PLACEHOLDER }))
  }
  db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, concurrency, status, total_rows,
    spend_limit_usd) VALUES (?,?,?,?,'Say hi to /name',?,?,'pending',?,?)`)
    .run(runId, sid, uid, OUT, model, concurrency, n, limit)
  return { sid, runId }
}
const cells = (sid: string) => db.prepare(`SELECT json_extract(data, ?) FROM rows WHERE sheet_id = ?
  ORDER BY row_index`).pluck().all(`$."${OUT}"`, sid) as string[]
const runRow = (id: string) => db.prepare(`SELECT status, pause_reason, error_message, worker_generation,
  spend_limit_usd FROM ai_runs WHERE id = ?`).get(id) as {
    status: string; pause_reason: string | null; error_message: string | null; worker_generation: number;
    spend_limit_usd: number | null }
const holds = (runId?: string) => db.prepare('SELECT COUNT(*) FROM ai_run_holds WHERE ? IS NULL OR run_id = ?')
  .pluck().get(runId ?? null, runId ?? null) as number
// The most one of these rows can cost: "Say hi to N0" is 12 bytes.
const mostOf = (runId: string) => rowMaxMicro({ prompt: 0.000001, completion: 0.000001, request: 0 },
  rowFixedOf(db.prepare('SELECT * FROM ai_runs WHERE id = ?').get(runId) as never), 12) / 1e6

let paused = { sid: '', runId: '' }
await ok('several rows out at once: it never spends past its limit and pauses when the next row could', async () => {
  calls = 0; mostInflight = 0
  paused = runOf(12, 3, 0.03)
  const most = mostOf(paused.runId)
  assert.ok(most > costUsd && most < 0.01, `a row's most ${most}`)
  await processAIRun(paused.runId, 0)
  const r = runRow(paused.runId)
  const spent = runSpentUsd(paused.runId, uid)
  assert.equal(r.status, 'paused')
  assert.equal(r.pause_reason, 'spend_limit')
  assert.match(r.error_message ?? '', /^The run reached its \$0\.03 spend limit \(\$0\.0\d+ spent\)\. The next row/)
  assert.ok(spent <= 0.03 + 1e-12, `spent ${spent}`)
  assert.ok(0.03 - spent < most, 'it used the room it had: what is left is less than one row\'s most')
  assert.ok(mostInflight >= 2 && mostInflight <= 3, `rows out at once: ${mostInflight}`)
  const c = cells(paused.sid)
  assert.equal(c.filter(v => v === 'Hello').length, calls)
  assert.equal(c.filter(v => v === PLACEHOLDER).length, 12 - calls, 'the rows not started stay ⏳')
  assert.ok(Math.abs(spent - calls * costUsd) < 1e-9, 'every call it made is counted')
  assert.equal(holds(paused.runId), 0, 'the worker dropped its hold')
  const summary = getAiRunSummary(paused.runId, uid) as unknown as Record<string, unknown>
  assert.equal(summary.spend_limit_usd, 0.03)
  assert.equal(summary.pause_reason, 'spend_limit')
  assert.equal(summary.pause_message, r.error_message)
})

await ok('a resume at a limit already spent is refused and changes nothing; a higher one finishes it', async () => {
  const before = runRow(paused.runId)
  const low = await resumeAiRun(paused.runId, uid, 0.001, true)
  assert.ok('fail' in low && low.fail === 'bad_request')
  assert.match(low.message, new RegExp('^The run paused at its \\$0\\.03 spend limit: it spent \\$0\\.0\\d+ and '
    + 'its next row could cost up to \\$0\\.00\\d+\\. Resume it with a higher spend_limit_usd, at least '
    + '\\$0\\.0\\d+, to go on\\.$'))
  const same = runRow(paused.runId)
  assert.deepEqual(same, before)
  const resumed = await resumeAiRun(paused.runId, uid, 1, true)
  assert.deepEqual(resumed, { ok: true })
  const r = runRow(paused.runId)
  assert.equal(r.status, 'pending')
  assert.equal(r.spend_limit_usd, 1)
  assert.equal(r.pause_reason, null)
  await processAIRun(paused.runId, r.worker_generation)
  assert.equal(runRow(paused.runId).status, 'completed')
  assert.ok(cells(paused.sid).every(v => v === 'Hello'))
  assert.equal(calls, 12, 'each row called once in all')
  assert.ok(Math.abs(runSpentUsd(paused.runId, uid) - 12 * costUsd) < 1e-9)
})

await ok('a run at its limit: a resume without a higher one is refused; one paused by hand resumes', async () => {
  const { runId } = runOf(2, 1, 0.01)
  db.prepare("UPDATE ai_runs SET status = 'paused', pause_reason = 'spend_limit' WHERE id = ?").run(runId)
  db.prepare('UPDATE run_usage SET ai_cost_usd = 0.01 WHERE run_id = ?').run(runId)
  const out = await resumeAiRun(runId, uid, undefined, true)
  assert.ok('fail' in out && out.fail === 'bad_request')
  assert.ok(out.message.includes('Resume it with a higher spend_limit_usd'), out.message)
  assert.equal(runRow(runId).status, 'paused')
  const bad = await resumeAiRun(runId, uid, -1, true)
  assert.ok('fail' in bad && bad.fail === 'bad_request' && bad.message.startsWith('spend_limit_usd must be'))
  // Paused at its limit with some left (the next row's most didn't fit): only a higher limit resumes it.
  db.prepare('UPDATE run_usage SET ai_cost_usd = 0.006 WHERE run_id = ?').run(runId)
  for (const same of [undefined, 0.01, 0.009]) {
    const out2 = await resumeAiRun(runId, uid, same, true)
    assert.ok('fail' in out2 && out2.fail === 'bad_request', `resumed with ${same}`)
    assert.equal(runRow(runId).spend_limit_usd, 0.01)
  }
  // Paused by hand with room left: it resumes as any run does, its limit kept.
  db.prepare('UPDATE ai_runs SET pause_reason = NULL WHERE id = ?').run(runId)
  assert.deepEqual(await resumeAiRun(runId, uid, undefined, true), { ok: true })
  assert.equal(runRow(runId).status, 'pending')
  assert.equal(runRow(runId).spend_limit_usd, 0.01)
  db.prepare("UPDATE ai_runs SET status = 'cancelled' WHERE id = ?").run(runId)
})

await ok("rows an earlier worker still has out are waited for; a hold older than a call can be isn't", async () => {
  calls = 0
  const { sid, runId } = runOf(3, 2, 0.05)
  // Generation 0's rows out hold all but half a cent of the limit: no row of this worker fits until they settle.
  db.prepare(`INSERT INTO ai_run_holds (run_id, worker_generation, user_id, hold_micro) VALUES (?, 0, ?, 45000)`)
    .run(runId, uid)
  db.prepare("UPDATE ai_runs SET worker_generation = 1 WHERE id = ?").run(runId)
  const running = processAIRun(runId, 1)
  await sleep(1_500)
  assert.equal(calls, 0, 'no row started while the earlier rows hold the room')
  assert.equal(runRow(runId).status, 'running')
  db.prepare('DELETE FROM ai_run_holds WHERE run_id = ? AND worker_generation = 0').run(runId)
  await running
  assert.equal(runRow(runId).status, 'completed')
  assert.ok(cells(sid).every(v => v === 'Hello'))

  calls = 0
  const stale = runOf(2, 2, 0.05)
  db.prepare(`INSERT INTO ai_run_holds (run_id, worker_generation, user_id, hold_micro, updated_at)
    VALUES (?, 0, ?, 50000, datetime('now', '-1 day'))`).run(stale.runId, uid)
  db.prepare("UPDATE ai_runs SET worker_generation = 1 WHERE id = ?").run(stale.runId)
  await processAIRun(stale.runId, 1)
  assert.equal(runRow(stale.runId).status, 'completed', 'a hold left by a worker that died long ago is ignored')
})

await ok('a model with no listed price stops once what was billed reaches the limit', async () => {
  calls = 0
  const { sid, runId } = runOf(6, 1, 0.012, 'test/unlisted')
  await processAIRun(runId, 0)
  const r = runRow(runId)
  assert.equal(r.status, 'paused')
  assert.equal(r.pause_reason, 'spend_limit')
  assert.match(r.error_message ?? '', /No price is listed for its model, so it stopped on what was billed/)
  const spent = runSpentUsd(runId, uid)
  assert.ok(spent >= 0.012 && spent <= 0.012 + costUsd + 1e-9, `spent ${spent}: past the limit by at most a row out`)
  assert.equal(cells(sid).filter(v => v === PLACEHOLDER).length, 6 - calls)
})

await ok("a row whose call may be billed counts its most as spent on the run; the others give it back", async () => {
  const { runId } = runOf(1, 1, 1)
  const gate = (await openSpendGate(db.prepare('SELECT * FROM ai_runs WHERE id = ?').get(runId) as never, 7, ['name']))!
  const row = { rowIndex: 0, data: { name: 'N0' } } as never
  const holdOf = () => db.prepare('SELECT hold_micro FROM ai_run_holds WHERE run_id = ? AND worker_generation = 7')
    .pluck().get(runId) as number | undefined
  const cutOff = () => db.prepare('SELECT spend_cut_off_micro FROM ai_runs WHERE id = ?').pluck().get(runId)
  const a = gate.admit(row)
  assert.ok('start' in a && a.start > 0)
  assert.equal(holdOf(), a.start)
  gate.settle(a.start, failedRow(AI_TIMEOUT_MESSAGE, true))
  assert.equal(holdOf(), 0)
  assert.equal(cutOff(), a.start, 'its most moved to the run: it counts as spent, for every worker')
  const b = gate.admit(row)
  assert.ok('start' in b)
  assert.equal(holdOf(), b.start)
  gate.settle(b.start, failedRow('Bad key'))
  assert.equal(holdOf(), 0)
  // The deadline's words alone don't keep it: the row says whether its call may be billed.
  const c = gate.admit(row)
  assert.ok('start' in c)
  gate.settle(c.start, failedRow(AI_TIMEOUT_MESSAGE))
  assert.equal(holdOf(), 0)
  assert.equal(cutOff(), a.start)
  gate.close()
  assert.equal(holdOf(), undefined)
  assert.equal(cutOff(), a.start, 'and stays when the worker ends')
})

await ok('a run without a limit holds nothing and runs as before; boot drops every hold', async () => {
  calls = 0
  const { sid, runId } = runOf(4, 4, null)
  let seen = 0
  const watch = setInterval(() => { seen = Math.max(seen, holds(runId)) }, 20)
  await processAIRun(runId, 0)
  clearInterval(watch)
  assert.equal(runRow(runId).status, 'completed')
  assert.ok(cells(sid).every(v => v === 'Hello'))
  assert.equal(seen, 0)
  db.prepare(`INSERT INTO ai_run_holds (run_id, worker_generation, user_id, hold_micro) VALUES (?, 5, ?, 1)`)
    .run(runId, uid)
  resetOrphanedRuns()
  assert.equal(holds(), 0)
})

server.close()
if (failures) { console.log(`${failures} failed`); process.exit(1) }
