// AI runs against a stand-in for OpenRouter on 127.0.0.1 (OPENROUTER_BASE_URL),
// through the real SDK, worker loop and writers on a migrated throwaway DB:
// rows failing in a row on the provider's side pause the run with the reason
// and leave the rest ⏳ (with none left it ends as usual); a body that never comes fails its row at the call's
// deadline; a cancel starts no more rows, and the calls out (each paid, so
// never cut off) end at their deadline writing nothing; a database that
// refuses writes stops the run after the one call it couldn't save.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
process.env.AI_CALL_DEADLINE_MS = '2500'
process.env.RUN_BREAKER_FAILURES = '5'

// --- The stand-in: what each POST to /chat/completions gets ---------------------
type Mode = 'ok' | 'fail' | 'stall'
let mode: Mode = 'ok'
let calls = 0
const server = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    calls++
    if (mode === 'stall') { res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders(); return }
    if (mode === 'fail') {
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
const { AI_TIMEOUT_MESSAGE } = await import('../../server/src/services/ai-row-outcome')
runMigrations()
console.warn = () => {}
console.error = () => {}

let failures = 0
const ok = async (label: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO settings (id, user_id, openrouter_api_key_encrypted) VALUES (?,?,?)')
  .run(uuid(), uid, encrypt('sk-or-test'))

const OUT = 'Hi (Output)'
// A sheet of `n` rows waiting on a run (their output cell ⏳), and that run.
const runOf = (n: number, concurrency: number) => {
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

await ok("rows failing in a row on the provider's side pause the run; the rest stay ⏳", async () => {
  mode = 'fail'; calls = 0
  const { sid, runId } = runOf(8, 1)
  await processAIRun(runId, 0)
  const r = runRow(runId)
  assert.equal(r.status, 'paused')
  assert.equal(r.pause_reason, 'provider_errors')
  assert.match(r.error_message ?? '', /^5 rows in a row failed .*so the run paused.*Last error: 500/)
  assert.equal(calls, 5, 'no call after the fifth failure')
  const c = cells(sid)
  assert.equal(c.filter(v => v.startsWith('❌')).length, 5)
  assert.equal(c.filter(v => v === PLACEHOLDER).length, 3)
  // Resumed once the provider answers: the rows still ⏳ go on.
  mode = 'ok'
  db.prepare("UPDATE ai_runs SET status = 'pending', worker_generation = 1, pause_reason = NULL WHERE id = ?")
    .run(runId)
  await processAIRun(runId, 1)
  assert.equal(runRow(runId).status, 'completed')
  assert.equal(cells(sid).filter(v => v === 'Hello').length, 3)
})

await ok('failing the last rows pauses nothing: with none left, the run ends as usual', async () => {
  mode = 'fail'
  const { sid, runId } = runOf(5, 1)
  await processAIRun(runId, 0)
  assert.equal(runRow(runId).status, 'completed')
  assert.equal(cells(sid).filter(v => v.startsWith('❌')).length, 5)
})

await ok('a body that never comes fails its row at the deadline, not never', async () => {
  mode = 'stall'
  const { sid, runId } = runOf(2, 2)
  const t = Date.now()
  await processAIRun(runId, 0)
  assert.ok(Date.now() - t < 6_000, `took ${Date.now() - t} ms`)
  assert.equal(runRow(runId).status, 'completed')
  assert.deepEqual(cells(sid).map(v => v.includes(AI_TIMEOUT_MESSAGE)), [true, true])
})

await ok('a cancel with every row waiting starts no more; the calls out end at their deadline', async () => {
  mode = 'stall'; calls = 0
  const { sid, runId } = runOf(5, 2)
  const t = Date.now()
  const running = processAIRun(runId, 0)
  await new Promise(r => setTimeout(r, 300))
  db.prepare("UPDATE ai_runs SET status = 'cancelled' WHERE id = ?").run(runId)
  await running
  assert.ok(Date.now() - t < 4_500, `took ${Date.now() - t} ms`)
  assert.equal(calls, 2, 'no row started after the cancel')
  assert.ok(cells(sid).every(v => v === PLACEHOLDER), 'a stopped run writes nothing, not even a timeout')
})

await ok("a database that refuses writes stops the run after the call it couldn't save", async () => {
  mode = 'ok'; calls = 0
  const { sid, runId } = runOf(4, 1)
  db.exec(`CREATE TRIGGER disk_full BEFORE INSERT ON ai_results BEGIN
    SELECT RAISE(ABORT, 'database or disk is full'); END`)
  try {
    await processAIRun(runId, 0)
  } finally {
    db.exec('DROP TRIGGER disk_full')
  }
  const r = runRow(runId)
  assert.equal(r.status, 'paused')
  assert.equal(r.pause_reason, 'storage')
  assert.equal(calls, 1, 'no more paid calls')
  assert.equal(cells(sid).filter(v => v === PLACEHOLDER).length, 4)
})

server.closeAllConnections()
server.close()
if (failures) { console.log(`${failures} ai-run-safety assertion(s) failed`); process.exit(1) }
console.log('All ai-run-safety assertions passed.')
process.exit(0)
