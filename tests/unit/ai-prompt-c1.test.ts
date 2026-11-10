// A cell holding U+0080-U+009F used in an AI column's prompt (/name): the
// request the provider gets, as bytes, through the real SDK and worker loop
// against a stand-in for OpenRouter on 127.0.0.1 (OPENROUTER_BASE_URL). The
// prompt carries the cell as it is, and an answer holding one keeps it.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

const ANSWER = 'Hi\u0085there'
const bodies: Buffer[] = []
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    bodies.push(Buffer.concat(chunks))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: 'gen-1', object: 'chat.completion', created: 0, model: 'test/model',
      choices: [{ index: 0, message: { role: 'assistant', content: ANSWER }, finish_reason: 'stop' }],
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
runMigrations()
console.warn = () => {}

const uid = uuid(), tid = uuid(), sid = uuid(), runId = uuid()
const OUT = 'Hi (Output)'
const VALUES = ['a\u0085b', 'FraudFighterâ\u0084¢']
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO settings (id, user_id, openrouter_api_key_encrypted) VALUES (?,?,?)')
  .run(uuid(), uid, encrypt('sk-or-test'))
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)')
  .run(sid, tid, uid, 'S', JSON.stringify(['name', OUT]))
VALUES.forEach((name, i) => db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  .run(uuid(), sid, uid, i, JSON.stringify({ name, [OUT]: PLACEHOLDER })))
db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, concurrency, status, total_rows)
  VALUES (?,?,?,?,'Say hi to /name','test/model',1,'pending',2)`).run(runId, sid, uid, OUT)

await processAIRun(runId, 0)
server.close()

// One call a row, in row order: the prompt is the cell as it is, as UTF-8 inside the JSON string (C2 85 for U+0085).
assert.equal(bodies.length, 2)
VALUES.forEach((v, i) => {
  const content = `Say hi to ${v}`
  assert.deepEqual(JSON.parse(bodies[i].toString('utf8')).messages, [{ role: 'user', content }])
  assert.ok(bodies[i].includes(Buffer.from(JSON.stringify(content), 'utf8')), `the bytes of ${JSON.stringify(content)}`)
})
assert.ok(bodies[0].includes(Buffer.from([0x61, 0xC2, 0x85, 0x62])))
// The answer's U+0085 is kept in the cell.
assert.deepEqual(db.prepare(`SELECT json_extract(data, ?) FROM rows WHERE sheet_id = ? ORDER BY row_index`)
  .pluck().all(`$."${OUT}"`, sid), [ANSWER, ANSWER])
console.log('ai-prompt-c1: all assertions passed')
process.exit(0)
