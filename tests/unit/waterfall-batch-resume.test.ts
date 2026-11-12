// A waterfall run paused before ":batch" models were refused at its start,
// with one as an AI step's model (frozen in the run): a resume over MCP
// control_run and REST POST /api/v1/http-runs/:id/resume is refused naming the
// step, as its start would be, before anything is sent: the run stays paused
// and a new spend limit sent with it isn't written. A step that is off doesn't
// count.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { v4 as uuid } from 'uuid'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import mcpMod from '../../server/src/mcp/build-server'
import controlMod from '../../server/src/routes/api-v1-run-control'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { buildMcpServer } = mcpMod as typeof import('../../server/src/mcp/build-server')
const { default: controlRouter } = controlMod as unknown as { default: express.Router }

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}
console.error = () => {}

const uid = uuid(), tid = uuid(), sid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
  .run(sid, tid, uid, 'S', JSON.stringify(['Name', 'Email']))
const aiStep = (id: string, label: string, model: string, on: boolean) => ({
  id, label, on, requires: [], choices: { kind: 'ai', prompt: 'Email of {{name}}', model, webSearch: false },
  built: { kind: 'ai', model, search: null, capUsd: 0.01, lowUsd: 0.001, highUsd: 0.002 },
})
// A paused waterfall run with these AI steps.
const pausedWaterfall = (steps: object[]) => {
  const id = uuid()
  const config = {
    requestConfig: { method: 'GET', url: 'https://example.invalid/', headers: {}, body: '' }, responseMapping: [],
    waterfall: { v: 1, resultType: 'text', inputs: [{ key: 'name', column: 'Name' }], steps, hideStepColumns: false,
      maxCostPerRowUsd: 0.01, tregCapPerRowUsd: 0, spendLimitUsd: null,
      rows: { mode: 'all', status: 'any', test: null }, fresh: false },
  }
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name)
    VALUES (?,?,?,?, 'paused', 'Email')`).run(id, sid, uid, JSON.stringify(config))
  return id
}
const BATCH = 'Step 2 (Ask AI): The model "openai/gpt-4o-mini:batch:nitro" is a batch-only variant: it runs only '
  + 'through OpenRouter\'s batch API, which Cubex doesn\'t use. Use "openai/gpt-4o-mini:nitro" instead.'

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
  const mcp = buildMcpServer({ userId: uid, tokenId: 'tok', tokenName: 'n', scopes: new Set(['read', 'write', 'run']) })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await mcp.connect(serverSide)
  const client = new Client({ name: 'unit', version: '1.0.0' })
  await client.connect(clientSide)
  const state = (id: string) => db.prepare(`SELECT status,
    json_extract(config, '$.waterfall.spendLimitUsd') AS limit_usd FROM http_runs WHERE id = ?`).get(id)

  const steps = [aiStep('saaaaaa', 'Off AI', 'google/gemini-2.5-flash:batch', false),
    aiStep('sbbbbbb', 'Ask AI', 'openai/gpt-4o-mini:batch:nitro', true)]
  const viaMcp = pausedWaterfall(steps)
  const res = await client.callTool({ name: 'control_run', arguments: { run_type: 'waterfall', run_id: viaMcp,
    action: 'resume', spend_limit_usd: 5 } }) as { isError?: boolean; content: Array<{ text: string }> }
  assert.deepEqual([res.isError, JSON.parse(res.content[0].text)], [true, { error: BATCH }], 'MCP')
  assert.deepEqual(state(viaMcp), { status: 'paused', limit_usd: null }, 'MCP: still paused, no new limit')

  const viaRest = pausedWaterfall(steps)
  const answer = await fetch(`${base}/http-runs/${viaRest}/resume`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spend_limit_usd: 5 }) })
  assert.deepEqual([answer.status, await answer.json()], [400, { error: BATCH }], 'REST')
  assert.deepEqual(state(viaRest), { status: 'paused', limit_usd: null }, 'REST: still paused, no new limit')
  console.log('ok   a paused waterfall with a :batch AI step is not resumed, over MCP and REST; an off step '
    + 'is not checked')

  await client.close()
  server.close()
}

main()
  .then(() => { console.log('All waterfall-batch-resume assertions passed.'); process.exit(0) })
  .catch(e => { console.log('FAIL', e); process.exit(1) })
