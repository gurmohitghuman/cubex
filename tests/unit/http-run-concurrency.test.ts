// concurrency on an HTTP API run's rerun and resume: what MCP control_run and
// the REST routes refuse, in their exact words, with HTTP_MAX_CONCURRENCY 20 (the
// Docker default) under the AI runs' 100. The schema bounds control_run's
// concurrency at the larger and names both; each kind's own bound is checked in
// the words REST answers; a waterfall run, a pause and an AI resume refuse it.
// The runs that do start (the real number of requests in flight, the stored
// batch size): tests/e2e/http-rerun-concurrency.spec.ts.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
process.env.HTTP_MAX_CONCURRENCY = '20'
const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { buildMcpServer } = await import('../../server/src/mcp/build-server')
const { Client } = await import('@modelcontextprotocol/client')
const { InMemoryTransport } = await import('@modelcontextprotocol/server')
const { default: controlRouter } = await import('../../server/src/routes/api-v1-run-control') as
  unknown as { default: express.Router }
runMigrations()
console.warn = () => {}

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const uid = uuid(), tid = uuid(), sid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
  .run(sid, tid, uid, 'S', JSON.stringify(['Name', 'Call', 'Email']))
const request = { requestConfig: { method: 'GET', url: 'https://example.com/{{Name}}', headers: {}, body: '' },
  responseMapping: [], batchSize: 2 }
const httpRun = (column: string, config: object) => {
  const id = uuid()
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name)
    VALUES (?,?,?,?, 'paused', ?)`).run(id, sid, uid, JSON.stringify(config), column)
  return id
}
const plain = httpRun('Call', request)
const waterfall = httpRun('Email', { ...request, waterfall: { v: 1 } })
const aiRun = uuid()
db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, status)
  VALUES (?,?,?,?,?,?, 'paused')`).run(aiRun, sid, uid, 'Hi (Output)', 'Hi /Name', 'openai/gpt-4o-mini')

const HTTP_WORDS = 'concurrency must be a whole number from 1 to 20.'
const SCHEMA_WORDS = 'Input validation error: Invalid arguments for tool control_run: concurrency: concurrency must be '
  + 'a whole number from 1 to 100 for an AI run, or from 1 to 20 for an HTTP API or enrichment run.'
const WHERE = 'concurrency applies only to rerunning an AI, HTTP API or enrichment run, or resuming an HTTP API or '
  + 'enrichment run.'
const WATERFALL = "concurrency doesn't apply to a waterfall run."

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
  const rest = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body) })
    return { status: res.status, json: await res.json() }
  }
  const mcp = buildMcpServer({ userId: uid, tokenId: 'tok', tokenName: 'n', scopes: new Set(['read', 'write', 'run']) })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await mcp.connect(serverSide)
  const client = new Client({ name: 'unit', version: '1.0.0' })
  await client.connect(clientSide)
  // The tool's answer: its error words (JSON) or the schema's refusal (text).
  const refusal = async (args: Record<string, unknown>) => {
    const res = await client.callTool({ name: 'control_run', arguments: args }) as
      { isError?: boolean; content: Array<{ text: string }> }
    assert.equal(res.isError, true, JSON.stringify(args))
    const text = res.content[0].text
    return text.startsWith('{') ? (JSON.parse(text) as { error: string }).error : text
  }
  const configOf = (id: string) => db.prepare('SELECT config FROM http_runs WHERE id = ?').pluck().get(id)

  await check('control_run publishes concurrency as an integer from 1 to the larger bound', async () => {
    const { tools } = await client.listTools()
    const field = tools.find(t => t.name === 'control_run')!.inputSchema.properties!.concurrency as
      Record<string, unknown>
    assert.deepEqual([field.type, field.minimum, field.maximum], ['integer', 1, 100])
  })

  await check('MCP: a value the schema refuses names both bounds; past the HTTP one, the REST words', async () => {
    for (const action of ['rerun', 'resume']) {
      for (const bad of [0, 101, 2.5, '3', null]) {
        assert.equal(await refusal({ run_type: 'http', run_id: plain, action, concurrency: bad }), SCHEMA_WORDS)
      }
      assert.equal(await refusal({ run_type: 'http', run_id: plain, action, concurrency: 21 }), HTTP_WORDS)
    }
    assert.equal(configOf(plain), JSON.stringify(request), 'the run is left as it was')
  })

  await check('REST: rerun and resume refuse a value out of the HTTP bound, or not a whole number', async () => {
    for (const path of [`/http-runs/${plain}/rerun`, `/http-runs/${plain}/resume`]) {
      for (const bad of [0, 21, 2.5, '3', null]) {
        assert.deepEqual(await rest(path, { concurrency: bad }), { status: 400, json: { error: HTTP_WORDS } }, path)
      }
    }
    assert.equal(configOf(plain), JSON.stringify(request), 'the run is left as it was')
    assert.equal(db.prepare('SELECT count(*) FROM http_runs').pluck().get(), 2, 'no run was made')
  })

  await check('a waterfall run refuses concurrency on rerun and resume, over MCP and REST', async () => {
    for (const action of ['rerun', 'resume']) {
      assert.equal(await refusal({ run_type: 'waterfall', run_id: waterfall, action, mode: 'all', concurrency: 3 }),
        WATERFALL)
      assert.equal(await refusal({ run_type: 'http', run_id: waterfall, action, mode: 'all', concurrency: 3 }),
        WATERFALL)
    }
    assert.deepEqual(await rest(`/http-runs/${waterfall}/rerun`, { mode: 'all', concurrency: 3 }),
      { status: 400, json: { error: 'first_rows and concurrency don\'t apply to a waterfall rerun.' } })
    assert.deepEqual(await rest(`/http-runs/${waterfall}/resume`, { concurrency: 3 }),
      { status: 400, json: { error: WATERFALL } })
  })

  await check('a pause, a cancel and an AI resume refuse concurrency, naming what takes it', async () => {
    for (const action of ['pause', 'cancel']) {
      assert.equal(await refusal({ run_type: 'http', run_id: plain, action, concurrency: 3 }), WHERE)
    }
    assert.equal(await refusal({ run_type: 'ai', run_id: aiRun, action: 'resume', concurrency: 3 }), WHERE)
    assert.deepEqual(await rest(`/ai-runs/${aiRun}/resume`, { concurrency: 3 }),
      { status: 400, json: { error: 'concurrency applies to resuming an HTTP API or enrichment run only.' } })
    assert.equal(db.prepare('SELECT status FROM ai_runs WHERE id = ?').pluck().get(aiRun), 'paused')
  })

  await client.close()
  server.close()
}

main()
  .catch(e => { failures++; console.log('FAIL threw', e) })
  .finally(() => {
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
    console.log('All http-run-concurrency assertions passed.')
    process.exit(0)
  })
