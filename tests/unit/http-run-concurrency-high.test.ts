// concurrency with HTTP_MAX_CONCURRENCY 150, above the AI runs' 100
// (lib/run-concurrency.ts): control_run publishes 150 as its maximum, as the
// docs say; a value past it is refused naming both bounds; an AI rerun past
// 100 is refused in the words REST uses, over MCP and REST alike; an HTTP API
// rerun takes 120 on both (it goes on to look the run up). Bounds of 20 and
// out-of-range words in detail: http-run-concurrency.test.ts.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
process.env.HTTP_MAX_CONCURRENCY = '150'
const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { buildMcpServer } = await import('../../server/src/mcp/build-server')
const { Client } = await import('@modelcontextprotocol/client')
const { InMemoryTransport } = await import('@modelcontextprotocol/server')
const { default: controlRouter } = await import('../../server/src/routes/api-v1-run-control') as
  unknown as { default: express.Router }
runMigrations()
console.warn = () => {}

const uid = uuid(), tid = uuid(), sid = uuid(), aiRun = uuid(), noRun = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
  .run(sid, tid, uid, 'S', JSON.stringify(['Name']))
db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, status)
  VALUES (?,?,?,?,?,?, 'completed')`).run(aiRun, sid, uid, 'Hi (Output)', 'Hi /Name', 'openai/gpt-4o-mini')
const AI_WORDS = 'concurrency must be a whole number from 1 to 100.'
const SCHEMA_WORDS = 'Input validation error: Invalid arguments for tool control_run: concurrency: concurrency must be '
  + 'a whole number from 1 to 100 for an AI run, or from 1 to 150 for an HTTP API or enrichment run.'

async function main() {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    Object.assign(req, { userId: uid, accessTokenId: 'tok', tokenScopes: new Set(['read', 'write', 'run']) }); next()
  })
  app.use(controlRouter)
  // Only this machine can reach it; the port is read once it listens.
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const rest = async (path: string, body: object) => {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body) })
    return { status: res.status, json: await res.json() }
  }
  const mcp = buildMcpServer({ userId: uid, tokenId: 'tok', tokenName: 'n', scopes: new Set(['read', 'write', 'run']) })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await mcp.connect(serverSide)
  const client = new Client({ name: 'unit', version: '1.0.0' })
  await client.connect(clientSide)
  const answer = async (args: Record<string, unknown>) => {
    const res = await client.callTool({ name: 'control_run', arguments: args }) as
      { isError?: boolean; content: Array<{ text: string }> }
    const text = res.content[0].text
    return text.startsWith('{') ? (JSON.parse(text) as { error: string }).error : text
  }

  const { tools } = await client.listTools()
  const field = tools.find(t => t.name === 'control_run')!.inputSchema.properties!.concurrency as
    Record<string, unknown>
  assert.deepEqual([field.type, field.minimum, field.maximum], ['integer', 1, 150], 'the published bound')
  assert.match(String(field.description), /HTTP API and enrichment 1-150/)
  assert.equal(await answer({ run_type: 'http', run_id: noRun, action: 'rerun', concurrency: 151 }), SCHEMA_WORDS)
  assert.equal(await answer({ run_type: 'ai', run_id: aiRun, action: 'rerun', mode: 'all', concurrency: 120 }),
    AI_WORDS, 'MCP: an AI rerun keeps its own bound')
  assert.deepEqual(await rest(`/ai-runs/${aiRun}/rerun`, { mode: 'all', concurrency: 120 }),
    { status: 400, json: { error: AI_WORDS } }, 'REST: the same words')
  // Past the bound check: the run is unknown (MCP adds the next step, mcp/next-steps.ts).
  assert.equal(await answer({ run_type: 'http', run_id: noRun, action: 'rerun', concurrency: 120 }),
    `HTTP run not found. No run has the run_id "${noRun}". list_runs lists a sheet's runs, newest first.`,
    'MCP: an HTTP API rerun takes 120')
  assert.deepEqual(await rest(`/http-runs/${noRun}/rerun`, { concurrency: 120 }),
    { status: 404, json: { error: 'HTTP run not found' } }, 'REST: so does it')
  assert.equal(db.prepare('SELECT count(*) FROM ai_runs').pluck().get(), 1, 'no run was made')
  console.log('ok   with HTTP_MAX_CONCURRENCY 150: published bound 150, each kind keeps its own, MCP and REST agree')

  await client.close()
  server.close()
}

main()
  .then(() => { console.log('All http-run-concurrency-high assertions passed.'); process.exit(0) })
  .catch(e => { console.log('FAIL', e); process.exit(1) })
