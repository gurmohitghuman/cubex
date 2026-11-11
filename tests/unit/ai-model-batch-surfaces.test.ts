// A ":batch" model runs only through OpenRouter's batch API, which Cubex doesn't
// use (lib/ai-model-check.ts). Over MCP (the real server, in memory) and REST
// (the real /api/v1 routers), with OpenRouter's model list a stand-in on
// 127.0.0.1 that holds one: run_ai_column refuses it named, as its start, its
// estimate and its preview do when a sheet's saved default names it, and the
// app's run form and preview too; a paused
// run on one isn't resumed and a finished one isn't rerun; a waterfall's AI step
// and set_default_model refuse it, routing variants after it too. All in the one
// lib message. list_models, GET /api/v1/models and the app's model picker leave
// it out. With the list down, a :batch model is still refused.
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
const MODEL = 'openai/gpt-4o-mini'
const LISTED = [MODEL, `${MODEL}:batch`, 'google/gemini-2.5-flash:batch', 'meta/llama-4:free']
let listUp = true
const openrouter = http.createServer((req, res) => {
  req.resume()
  res.writeHead(listUp ? 200 : 500, { 'content-type': 'application/json' })
  res.end(listUp ? JSON.stringify({ data: LISTED.map(id => ({ id, name: id, context_length: 1000,
    pricing: { prompt: '0.000001', completion: '0.000002' } })) }) : '{}')
})
openrouter.listen(0, '127.0.0.1')
await once(openrouter, 'listening')
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(openrouter.address() as AddressInfo).port}/api/v1`
// The list is cached 5 minutes: moving the clock on reads it again.
const realNow = Date.now
let shiftMs = 0
Date.now = () => realNow() + shiftMs

const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { buildMcpServer } = await import('../../server/src/mcp/build-server')
const { signToken } = await import('../../server/src/lib/auth')
const { SESSION_COOKIE_NAME } = await import('../../server/src/lib/cookie')
const { Client } = await import('@modelcontextprotocol/client')
const { InMemoryTransport } = await import('@modelcontextprotocol/server')
const routers = await Promise.all(['api-v1-runs', 'api-v1-run-control', 'api-v1-run-reads', 'api-v1-waterfall',
  'settings-openrouter', 'ai-run-start', 'ai-preview']
  .map(async name => (await import(`../../server/src/routes/${name}`)).default as express.Router))
runMigrations()
console.warn = () => {}
console.error = () => {}

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
const words = (id: string, use: string) => `The model "${id}" is a batch-only variant: it runs only through `
  + `OpenRouter's batch API, which Cubex doesn't use. Use "${use}" instead.`

const uid = uuid(), tid = uuid(), sid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
  .run(sid, tid, uid, 'S', JSON.stringify(['Name', 'Old (Output)']))
db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  .run(uuid(), sid, uid, 0, JSON.stringify({ Name: 'Ada', 'Old (Output)': 'hello' }))
// Runs and a sheet default saved before :batch models were refused (no service makes them now).
const storedRun = (status: string) => {
  const id = uuid()
  db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, status)
    VALUES (?,?,?,?,?,?,?)`).run(id, sid, uid, 'Old (Output)', 'Hi /name', `${MODEL}:batch`, status)
  return id
}

async function main() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', (req, _res, next) => {
    Object.assign(req, { userId: uid, accessTokenId: 'tok', tokenScopes: new Set(['read', 'write', 'run']) }); next()
  }, ...routers.slice(0, 4))
  const signedIn: express.RequestHandler = (req, _res, next) => {
    Object.assign(req, { cookies: { [SESSION_COOKIE_NAME]: signToken({ userId: uid, sessionEpoch: 0 }) } }); next()
  }
  app.use('/api/settings', signedIn, routers[4])
  app.use('/api/ai', signedIn, routers[5], routers[6])
  // Only this machine can reach it; the port is read once it listens.
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const rest = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, json: await res.json() as Record<string, unknown> }
  }
  const mcp = buildMcpServer({ userId: uid, tokenId: 'tok', tokenName: 'n', scopes: new Set(['read', 'write', 'run']) })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await mcp.connect(serverSide)
  const client = new Client({ name: 'unit', version: '1.0.0' })
  await client.connect(clientSide)
  const tool = async (name: string, args: Record<string, unknown>) => {
    type Res = { isError?: boolean; content: Array<{ text: string }> }
    const res = await client.callTool({ name, arguments: args }) as Res
    return { isError: res.isError === true, json: JSON.parse(res.content[0].text) as Record<string, unknown> }
  }
  const refusedBoth = async (label: string, mcpCall: () => ReturnType<typeof tool>,
    restCall: () => ReturnType<typeof rest>, expected: string) => {
    await check(label, async () => {
      assert.deepEqual(await mcpCall(), { isError: true, json: { error: expected } })
      assert.deepEqual(await restCall(), { status: 400, json: { error: expected } })
    })
  }
  let n = 0
  const ai = () => ({ column_name: `Hi ${++n}`, prompt: 'Hi /name' })

  await refusedBoth('a run on a :batch model is refused, a routing variant after it too',
    () => tool('run_ai_column', { sheet_id: sid, ...ai(), model: `${MODEL}:batch:nitro` }),
    () => rest('POST', `/api/v1/sheets/${sid}/ai-runs`, { ...ai(), model: `${MODEL}:batch:nitro` }),
    words(`${MODEL}:batch:nitro`, `${MODEL}:nitro`))
  db.prepare('UPDATE sheets SET default_ai_model = ? WHERE id = ?').run(`${MODEL}:batch`, sid)
  const fromDefault: Array<[string, Record<string, unknown>]> =
    [['start', {}], ['estimate', { estimate_only: true }], ['preview', { preview_rows: 1 }]]
  for (const [what, extra] of fromDefault) {
    await refusedBoth(`a saved :batch default: the ${what} is refused`,
      () => tool('run_ai_column', { sheet_id: sid, ...ai(), ...extra }),
      () => rest('POST', `/api/v1/sheets/${sid}/ai-runs`, { ...ai(), ...extra }), words(`${MODEL}:batch`, MODEL))
  }
  await check("the app's run form and preview refuse a saved :batch default", async () => {
    const app = { sheetId: sid, columnName: 'App', prompt: 'Hi /name' }
    const expected = { status: 400, json: { error: words(`${MODEL}:batch`, MODEL) } }
    assert.deepEqual(await rest('POST', '/api/ai/run', app), expected)
    assert.deepEqual(await rest('POST', '/api/ai/preview', { ...app, previewSize: 1 }), expected)
  })
  db.prepare('UPDATE sheets SET default_ai_model = NULL WHERE id = ?').run(sid)
  await check('none of those made a run', () => {
    assert.equal(db.prepare('SELECT count(*) FROM ai_runs').pluck().get(), 0)
  })

  const paused = storedRun('paused')
  await refusedBoth('a paused run on a :batch model is not resumed',
    () => tool('control_run', { run_type: 'ai', run_id: paused, action: 'resume' }),
    () => rest('POST', `/api/v1/ai-runs/${paused}/resume`, {}), words(`${MODEL}:batch`, MODEL))
  await check('the refused run stays paused', () => {
    assert.equal(db.prepare('SELECT status FROM ai_runs WHERE id = ?').pluck().get(paused), 'paused')
  })
  db.prepare("UPDATE ai_runs SET status = 'completed' WHERE id = ?").run(paused)
  await refusedBoth('a finished run on a :batch model is not rerun',
    () => tool('control_run', { run_type: 'ai', run_id: paused, action: 'rerun', mode: 'all' }),
    () => rest('POST', `/api/v1/ai-runs/${paused}/rerun`, { mode: 'all' }), words(`${MODEL}:batch`, MODEL))

  const waterfall = { column_name: 'Email', result_type: 'text', inputs: { full_name: 'Name' },
    steps: [{ kind: 'ai', prompt: 'Email of /full_name', model: 'google/gemini-2.5-flash:batch' }] }
  await refusedBoth("a waterfall's AI step on a :batch model is refused",
    () => tool('waterfall_column', { sheet_id: sid, ...waterfall }),
    () => rest('POST', `/api/v1/sheets/${sid}/waterfall-columns`, { ...waterfall, estimate_only: true }),
    `Step 1: ${words('google/gemini-2.5-flash:batch', 'google/gemini-2.5-flash')}`)

  await check('set_default_model refuses a :batch model, for the account and a sheet, and saves nothing', async () => {
    for (const args of [{ model: `${MODEL}:batch` }, { model: `${MODEL}:batch`, sheet_id: sid }]) {
      assert.deepEqual(await tool('set_default_model', args),
        { isError: true, json: { error: words(`${MODEL}:batch`, MODEL) } })
    }
    assert.equal(db.prepare('SELECT default_ai_model FROM sheets WHERE id = ?').pluck().get(sid), null)
  })

  await check('list_models, GET /api/v1/models and the app\'s model picker leave :batch models out', async () => {
    const runnable = [MODEL, 'meta/llama-4:free']
    const listed = await tool('list_models', { limit: 100 })
    assert.deepEqual([listed.isError, (listed.json.models as Array<{ id: string }>).map(m => m.id),
      listed.json.total_matching], [false, runnable, 2])
    const searched = await tool('list_models', { search: 'gpt-4o-mini' })
    assert.deepEqual((searched.json.models as Array<{ id: string }>).map(m => m.id), [MODEL])
    const v1 = await rest('GET', '/api/v1/models?limit=500')
    assert.deepEqual([v1.status, (v1.json.models as Array<{ id: string }>).map(m => m.id)], [200, runnable])
    const app = await rest('GET', '/api/settings/openrouter-models')
    assert.deepEqual([app.status, (app.json as unknown as Array<{ id: string }>).map(m => m.id)], [200, runnable])
  })

  listUp = false
  shiftMs += 6 * 60_000
  await check('with the model list down a :batch model is still refused', async () => {
    const out = await tool('set_default_model', { model: `${MODEL}:batch@preset/mail` })
    const expected = words(`${MODEL}:batch@preset/mail`, `${MODEL}@preset/mail`)
    assert.deepEqual(out, { isError: true, json: { error: expected } })
  })

  await client.close()
  server.close()
}

main()
  .catch(e => { failures++; console.log('FAIL threw', e) })
  .finally(() => {
    openrouter.close()
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
    console.log('All ai-model-batch-surfaces assertions passed.')
    process.exit(0)
  })
