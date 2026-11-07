// "Only run if" rules read on a held column (services/run-rule.ts startRunRule, services/autorun-loop.ts): seeding
// judges each row on the rule as a run starts, and a column another run is filling (or a stopped one is putting
// back) holds ⏳ there, which reads as empty. So an AI column's rerun whose stored rule reads such a column is
// refused with the shared words, nothing made, and auto-run starts no batch while its own rule reads one, its rows
// staying queued; once the column is free both go on. OpenRouter is a stand-in on 127.0.0.1.
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
const MODEL = 'test/model'
const stand = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: MODEL, name: MODEL, pricing: { prompt: '0', completion: '0' } }] }))
  })
})
await new Promise<void>(r => stand.listen(0, '127.0.0.1', r))
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(stand.address() as AddressInfo).port}/api/v1`

const { undoKit } = await import('./run-undo-kit')
const { encrypt } = await import('../../server/src/lib/crypto')
const { seedProcessingPlaceholders } = await import('../../server/src/lib/placeholder-cells')
const { clearRunPlaceholders } = await import('../../server/src/lib/run-placeholders')
const { startAiRun } = await import('../../server/src/services/ai-run-start')
const { rerunAiColumn } = await import('../../server/src/services/ai-run-rerun')
const { parseRunRequest } = await import('../../server/src/routes/ai-run-parse')
const { saveAutorunSettings } = await import('../../server/src/services/autorun-settings')
const { autorunTick } = await import('../../server/src/services/autorun-loop')
const { db, uid, ok, done, idle, sheet } = undoKit('rule-held-starts')
console.error = () => {}
db.prepare('INSERT INTO settings (id, user_id, openrouter_api_key_encrypted) VALUES (?,?,?)')
  .run(uuid(), uid, encrypt('sk-or-test'))
createRequire(path.resolve('server/src/queue.ts'))('sidequest').Sidequest.build = () => ({ enqueue: async () => ({}) })

// A rerun of Answer going on `targets` (all rows: null); stop() leaves it as a cancel does, back() clears it.
async function hold(sid: string, targets: number[] | null = null) {
  const run = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,'{}','running','Answer')`).run(run, sid, uid)
  await seedProcessingPlaceholders({ run: { kind: 'http', id: run }, sheetId: sid, userId: uid, columns: ['Answer'],
    targets, lastRow: 1, live: () => true })
  return {
    stop: () => db.prepare(`UPDATE http_runs SET status = 'cancelled', placeholder_work = 'clearing'
      WHERE id = ?`).run(run),
    back: () => clearRunPlaceholders('http', run),
  }
}
const RULE = '{{Answer}} is not empty'
const refusal = (hold: 'going' | 'clearing') => ({ fail: 'conflict', held: { column: 'Answer', hold },
  message: hold === 'going'
    ? '"Only run if" reads "Answer", which a run that hasn\'t finished is still filling. Wait for that run to '
      + 'finish (or stop it), then try again.'
    : '"Only run if" reads "Answer", which is getting back what it held before a stopped run. Try again in a moment.',
})

await ok('an AI column\'s rerun whose stored "Only run if" reads a held column is refused, going and clearing, '
  + 'nothing made; after the clear it starts', async () => {
  const sid = sheet([{ Name: 'ada', Answer: 'a' }, { Name: 'bob', Answer: 'b' }], ['Name', 'Answer'])
  const first = await startAiRun(uid, parseRunRequest({ sheetId: sid, columnName: 'Hi', prompt: 'Greet /Name',
    model: MODEL, runIf: RULE }) as never)
  assert.ok('ok' in first, JSON.stringify(first))
  await idle(sid)
  db.prepare("UPDATE ai_runs SET status = 'completed' WHERE id = ?").run(first.ok.runId)
  const h = await hold(sid)
  const rerun = () => rerunAiColumn(uid, { sheetId: sid, baseColumnName: 'Hi', columnName: 'Hi (Output)' })
  const runs = () => db.prepare('SELECT COUNT(*) FROM ai_runs WHERE sheet_id = ?').pluck().get(sid)
  assert.deepEqual(await rerun(), refusal('going'))
  h.stop()
  assert.deepEqual(await rerun(), refusal('clearing'))
  assert.equal(runs(), 1, 'no run made')
  await h.back()
  const out = await rerun()
  assert.ok('ok' in out, JSON.stringify(out))
  await idle(sid)
})

await ok('auto-run starts no batch while its own "Only run if" reads a held column, its row staying queued; once '
  + 'it\'s free the next tick starts one', async () => {
  const sid = sheet([{ Name: 'ada', Answer: 'a' }, { Name: 'bob', Answer: 'b' }], ['Name', 'Answer', 'Push'])
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name,allow_secrets)
    VALUES (?,?,?,?,'completed','Push',1)`).run(uuid(), sid, uid, JSON.stringify({ requestConfig: { method: 'POST',
    url: 'https://api.example.com/push', headers: {}, body: '{"n":"{{Name}}"}' }, responseMapping: [] }))
  const on = await saveAutorunSettings(uid, sid, { column: 'Push', enabled: true, where: null, runIf: RULE,
    dailyCapUsd: null, dailyRowCap: null }, { hasSecretsScope: true })
  assert.ok('ok' in on, JSON.stringify(on))
  db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,2,?)')
    .run(uuid(), sid, uid, JSON.stringify({ Name: 'cy', Answer: 'c' }))
  const h = await hold(sid, [0, 1])
  const entry = db.prepare("SELECT id FROM autorun_columns WHERE sheet_id = ? AND status_column = 'Push'").pluck()
    .get(sid) as string
  const batches = () => db.prepare('SELECT COUNT(*) FROM http_runs WHERE autorun_id = ?').pluck().get(entry)
  await autorunTick(entry)
  assert.equal(batches(), 0, 'no batch while Answer is held')
  h.stop()
  await autorunTick(entry)
  assert.equal(batches(), 0, 'nor while it is put back')
  await h.back()
  await autorunTick(entry)
  assert.equal(batches(), 1)
})

stand.close()
done()
