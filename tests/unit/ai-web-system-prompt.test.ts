// A one-column AI run with page reading on keeps the column's system prompt: the request the provider gets,
// through the real SDK and worker loop against a stand-in for OpenRouter on 127.0.0.1 (OPENROUTER_BASE_URL),
// sends the system prompt first, then the note on using what web tools bring back. Without a system prompt the
// row gets the web message alone, and without web tools the system prompt alone. The preview sends the same, the
// draft hash keys on the system prompt (no stale preview answers reused), and the spend limit counts the
// bytes that are sent (lib/ai-spend-limit.ts rowFixedFor). (Before: the web message replaced the system prompt.)
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { passed } from './ends-on-its-own'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

const bodies: Array<{ messages: Array<{ role: string; content: string }>; tools?: Array<{ type: string }> }> = []
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    if (req.url?.endsWith('/chat/completions')) bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: 'gen-1', object: 'chat.completion', created: 0, model: 'test/model',
      choices: [{ index: 0, message: { role: 'assistant', content: '4' }, finish_reason: 'stop' }],
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
const { rowFixedFor } = await import('../../server/src/lib/ai-spend-limit')
const { proseSystemMessage } = await import('../../server/src/lib/ai-web-tools')
runMigrations()
console.warn = () => {}

const RULES = 'Score the company from 1 to 5 for fit. Answer with the number only.'
const uid = uuid(), tid = uuid(), sid = uuid()
const OUTS = ['Fit', 'Fit (no rules)', 'Fit (no web)']
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO settings (id, user_id, openrouter_api_key_encrypted) VALUES (?,?,?)')
  .run(uuid(), uid, encrypt('sk-or-test'))
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)')
  .run(sid, tid, uid, 'S', JSON.stringify(['Website', ...OUTS]))
const cells = { Website: 'acme.com', ...Object.fromEntries(OUTS.map(o => [o, PLACEHOLDER])) }
db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  .run(uuid(), sid, uid, 0, JSON.stringify(cells))

async function run(column: string, systemPrompt: string | null, webFetch: boolean) {
  const id = uuid()
  db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, system_prompt, model, concurrency,
    status, total_rows, use_web_fetch) VALUES (?,?,?,?,'Read /Website and score it',?,'test/model',1,'pending',1,?)`)
    .run(id, sid, uid, column, systemPrompt, webFetch ? 1 : 0)
  await processAIRun(id, 0)
  return bodies[bodies.length - 1]
}
const fixedBytes = (systemPrompt: string | null, fetch: boolean) => rowFixedFor({
  model: 'test/model', systemPrompt, outputColumns: null, maxChars: null,
  web: { search: false, fetch, used: null, mode: null, maxPerRow: null },
}).fixedBytes

// Page reading on, with a system prompt: the system prompt first, then the web note, in one system message.
const withRules = await run(OUTS[0], RULES, true)
assert.equal(withRules.messages.length, 2)
assert.equal(withRules.messages[0].role, 'system')
assert.ok(withRules.messages[0].content.startsWith(`${RULES}\n\n`), 'the system prompt comes first, whole')
assert.match(withRules.messages[0].content, /fetched pages/, 'the web note follows it')
assert.doesNotMatch(withRules.messages[0].content, /You are a helpful AI assistant/)
assert.deepEqual(withRules.tools?.map(t => t.type), ['openrouter:web_fetch'])
assert.equal(fixedBytes(RULES, true), Buffer.byteLength(withRules.messages[0].content, 'utf8'),
  'the spend limit counts the system message that is sent')
console.log('ok   page reading keeps the system prompt, the web note after it, and the limit counts both')

// Page reading on, no system prompt: the web message alone.
const noRules = await run(OUTS[1], null, true)
assert.equal(noRules.messages[0].role, 'system')
assert.match(noRules.messages[0].content, /^You are a helpful AI assistant/)
assert.equal(fixedBytes(null, true), Buffer.byteLength(noRules.messages[0].content, 'utf8'))
console.log('ok   page reading without a system prompt sends the web message')

// No web tools: the system prompt as it is.
const noWeb = await run(OUTS[2], RULES, false)
assert.deepEqual(noWeb.messages[0], { role: 'system', content: RULES })
assert.equal(noWeb.tools, undefined)
assert.equal(proseSystemMessage(null, false), null)
assert.equal(proseSystemMessage('', true), proseSystemMessage(null, true))
assert.equal(proseSystemMessage(' \n ', true), proseSystemMessage(null, true), 'a blank one gets the web message')
console.log('ok   without web tools the system prompt goes as it is; a blank one with them, the web message')

// The preview sends what the run sends (routes/ai-preview-runner.ts): a prose row the same system message, a
// structured one (its JSON instruction after the prompt) the system prompt as it is, as ai-row-multi.ts does.
const { getOpenRouterClient } = await import('../../server/src/services/openrouter')
const { processOneRow, structuredPreview } = await import('../../server/src/routes/ai-preview-runner')
const client = await getOpenRouterClient(uid)
const previewArgs = { prompt: 'Read /Website and score it', columns: ['Website', ...OUTS], systemPrompt: RULES,
  model: 'test/model', safeTemperature: 0.7, search: null, useWebFetch: true }
await processOneRow({ rowIndex: 0, data: cells }, client, previewArgs)
assert.deepEqual(bodies[bodies.length - 1].messages[0], withRules.messages[0], 'a prose preview: the run\'s message')
const specs = [{ columnName: 'Fit', type: 'string' as const, description: 'fit from 1 to 5' }]
await processOneRow({ rowIndex: 0, data: cells }, client, { ...previewArgs, ...structuredPreview(specs, true).args })
assert.deepEqual(bodies[bodies.length - 1].messages[0], { role: 'system', content: RULES })
console.log('ok   a preview sends the system message its run sends, prose or structured')

// A draft's preview answers are reused by its run only when the config matches (lib/ai-run-promote.ts): with
// page reading on, a changed system prompt changes the answers, so it changes the hash.
const { computeConfigHash } = await import('../../server/src/lib/ai-drafts')
const draft = { columnName: 'Fit', prompt: 'p', systemPrompt: 'Answer in French', model: 'test/model',
  temperature: 0.7, useOpenRouterWebSearch: false, useWebFetch: true, maxChars: null, concurrency: 5 }
assert.notEqual(computeConfigHash(draft), computeConfigHash({ ...draft, systemPrompt: 'Answer in English' }))
assert.notEqual(computeConfigHash(draft), computeConfigHash({ ...draft, systemPrompt: null }))
console.log('ok   with web tools a changed system prompt keeps a preview\'s answers out of the run')

server.close()
assert.equal(bodies.length, 5, 'one call a run or preview row')
assert.deepEqual(db.prepare(`SELECT ${OUTS.map(() => 'json_extract(data, ?)').join(', ')} FROM rows WHERE sheet_id = ?`)
  .raw().get(...OUTS.map(o => `$."${o}"`), sid), ['4', '4', '4'])
console.log('ai-web-system-prompt: all assertions passed')
passed()
