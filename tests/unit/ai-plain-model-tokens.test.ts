// A one-column AI row on a model that doesn't think first sends a smaller max_tokens (lib/ai-output-tokens.ts):
// about max_chars / 3 + 256, or 4,096 without max_chars; a model that thinks, may think, or isn't known keeps the
// 8,000 floor, and so does a structured row. The run's spend limit holds what the row sends, so a small limit runs
// rows on such a model, and the row sends exactly what its gate held. Through the real worker loop against a
// stand-in for OpenRouter on 127.0.0.1 (OPENROUTER_BASE_URL) serving a model list with each kind of model.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { passed } from './ends-on-its-own'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

const price = { prompt: '0.000001', completion: '0.00001' }
const model = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, context_length: 100_000,
  pricing: price, supported_parameters: ['max_tokens', 'temperature'], ...extra })
const MODELS = [
  model('test/plain'),
  model('test/thinks', { supported_parameters: ['max_tokens', 'temperature', 'reasoning', 'include_reasoning'] }),
  model('test/optional-thinking', { reasoning: { mandatory: false, default_effort: 'high' } }),
  model('test/reasoning-price', { pricing: { ...price, internal_reasoning: '0.00001' } }),
  model('test/aliased', { alias_target: 'test/thinks' }),
  model('~test/latest'),
  model('test/no-params', { supported_parameters: undefined }),
]
const bodies: Array<{ model: string; max_tokens?: number }> = []
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url?.endsWith('/models')) { res.end(JSON.stringify({ data: MODELS })); return }
    bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    res.end(JSON.stringify({
      id: 'gen-1', object: 'chat.completion', created: 0, model: 'test/plain',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Yes' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21, cost: 0.00003 },
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
const { fetchModels, modelThinksFirst } = await import('../../server/src/lib/openrouter')
const { proseMaxTokens, rowMaxTokens } = await import('../../server/src/lib/ai-output-tokens')
const { rowFixedFor } = await import('../../server/src/lib/ai-spend-limit')
const { AI_MIN_OUTPUT_TOKENS, AI_PLAIN_OUTPUT_TOKENS } = await import('../../server/src/lib/constants')
runMigrations()
console.warn = () => {}

// --- The rule -------------------------------------------------------------------------------
assert.equal(proseMaxTokens(null, false), AI_PLAIN_OUTPUT_TOKENS)
assert.equal(proseMaxTokens(20, false), Math.ceil(20 / 3) + 256)
assert.equal(proseMaxTokens(12_000, false), 4_256, 'max_chars 12,000 still fits')
assert.equal(proseMaxTokens(1_000_000, false), 16_000, 'capped at the ceiling')
for (const thinks of [true, null]) assert.equal(proseMaxTokens(20, thinks), AI_MIN_OUTPUT_TOKENS)
console.log('ok   a model that doesn\'t think first: max_chars / 3 + 256, or 4,096; otherwise the 8,000 floor')

// --- Which models don't think first: no sign of it at all in the list ---------------------------
assert.equal(modelThinksFirst('test/plain'), null, 'nothing is known before the list is read')
await fetchModels(Date.now())
assert.equal(modelThinksFirst('test/plain'), false)
assert.equal(modelThinksFirst('test/plain:nitro'), false, 'a routing variant is read as its model')
for (const id of ['test/thinks', 'test/optional-thinking', 'test/reasoning-price', 'test/aliased', '~test/latest',
  'test/no-params']) {
  assert.equal(modelThinksFirst(id), true, id)
}
assert.equal(modelThinksFirst('test/unlisted'), null)
assert.equal(rowMaxTokens({ model: 'test/plain', maxChars: 20, structured: true }), AI_MIN_OUTPUT_TOKENS,
  'a structured row keeps the floor')
const fixed = (m: string, outputColumns: unknown = null) => rowFixedFor({ model: m, systemPrompt: null,
  outputColumns: outputColumns as never, maxChars: 20,
  web: { search: false, fetch: false, used: null, mode: null, maxPerRow: null } }).maxTokens
assert.equal(fixed('test/plain'), 263)
assert.equal(fixed('test/thinks'), AI_MIN_OUTPUT_TOKENS)
assert.equal(fixed('test/plain', [{ columnName: 'A', type: 'string', description: 'a' }]), AI_MIN_OUTPUT_TOKENS)
console.log('ok   only a listed model with no reasoning parameter, block, price, alias or router counts as plain')

// --- Real runs ------------------------------------------------------------------------------------
const uid = uuid(), tid = uuid(), sid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO settings (id, user_id, openrouter_api_key_encrypted) VALUES (?,?,?)')
  .run(uuid(), uid, encrypt('sk-or-test'))
const OUTS = ['Plain', 'Plain long', 'Thinks']
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)')
  .run(sid, tid, uid, 'S', JSON.stringify(['Company', ...OUTS]))
for (let i = 0; i < 3; i++) {
  const cells = { Company: `Company ${i}`, ...Object.fromEntries(OUTS.map(o => [o, PLACEHOLDER])) }
  db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
    .run(uuid(), sid, uid, i, JSON.stringify(cells))
}
async function run(column: string, m: string, maxChars: number | null, limitUsd: number | null) {
  const id = uuid()
  db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, concurrency, status, total_rows,
    max_chars, spend_limit_usd) VALUES (?,?,?,?,'Is /Company a fit? Yes or No.',?,2,'pending',3,?,?)`)
    .run(id, sid, uid, column, m, maxChars, limitUsd)
  const before = bodies.length
  await processAIRun(id, 0)
  const status = db.prepare('SELECT status, pause_reason FROM ai_runs WHERE id = ?').get(id) as
    { status: string; pause_reason: string | null }
  return { sent: bodies.slice(before).map(b => b.max_tokens), ...status }
}

// A yes/no column on a plain model under a $0.01 limit: each row's most is about $0.003, so every row runs.
const small = await run(OUTS[0], 'test/plain', 20, 0.01)
assert.equal(small.status, 'completed', JSON.stringify(small))
assert.deepEqual(small.sent, [263, 263, 263], 'each row sends what its gate held')
console.log('ok   a small limit runs a short column on a plain model; each row sends the max_tokens held')

// No max_chars, no limit: 4,096.
const long = await run(OUTS[1], 'test/plain', null, null)
assert.deepEqual(long.sent, [AI_PLAIN_OUTPUT_TOKENS, AI_PLAIN_OUTPUT_TOKENS, AI_PLAIN_OUTPUT_TOKENS])
console.log('ok   without max_chars a plain model gets 4,096')

// A model that thinks keeps the 8,000 floor: $0.08 a row is over the same $0.01, so the run pauses at once.
const thinking = await run(OUTS[2], 'test/thinks', 20, 0.01)
assert.equal(thinking.status, 'paused')
assert.equal(thinking.pause_reason, 'spend_limit')
assert.deepEqual(thinking.sent, [])
console.log('ok   a model that thinks keeps its room, and the same limit pauses it before a row')

server.close()
console.log('ai-plain-model-tokens: all assertions passed')
passed()
