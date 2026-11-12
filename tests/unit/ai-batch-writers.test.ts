// write_formula and write_run_condition (MCP) and their REST routes,
// POST /api/v1/sheets/:id/formula-columns/write and .../run-conditions/generate,
// refuse a ":batch" model before anything is sent (services/run-condition-ai.ts
// writerModel), named or saved as the sheet's default, in the words every other
// model check uses (lib/ai-model-check.ts). REST answers 400; MCP an error.
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
import formulaMod from '../../server/src/routes/api-v1-formula'
import conditionsMod from '../../server/src/routes/api-v1-run-conditions'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { buildMcpServer } = mcpMod as typeof import('../../server/src/mcp/build-server')
const { default: formulaRouter } = formulaMod as unknown as { default: express.Router }
const { default: conditionsRouter } = conditionsMod as unknown as { default: express.Router }

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
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
  .run(sid, tid, uid, 'S', JSON.stringify(['Name']))
db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  .run(uuid(), sid, uid, 0, JSON.stringify({ Name: 'Ada' }))

async function main() {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    Object.assign(req, { userId: uid, accessTokenId: 'tok', tokenScopes: new Set(['read', 'write', 'run']) }); next()
  })
  app.use(formulaRouter, conditionsRouter)
  // Only this machine can reach it; the port is read once it listens.
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/sheets/${sid}`
  const rest = async (path: string, body: object) => {
    const res = await fetch(`${base}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body) })
    return { status: res.status, json: await res.json() }
  }
  const mcp = buildMcpServer({ userId: uid, tokenId: 'tok', tokenName: 'n', scopes: new Set(['read', 'write', 'run']) })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await mcp.connect(serverSide)
  const client = new Client({ name: 'unit', version: '1.0.0' })
  await client.connect(clientSide)
  const tool = async (name: string, args: object) => {
    const res = await client.callTool({ name, arguments: { sheet_id: sid, ...args } }) as
      { isError?: boolean; content: Array<{ text: string }> }
    return { isError: res.isError === true, json: JSON.parse(res.content[0].text) }
  }
  const writers: Array<[string, string, object]> = [
    ['write_formula', 'formula-columns/write', { words: 'the name in capitals' }],
    ['write_run_condition', 'run-conditions/generate', { text: 'the name is Ada' }],
  ]
  const both = async (model: string | undefined, expected: string) => {
    for (const [name, path, ask] of writers) {
      const args = model === undefined ? ask : { ...ask, model }
      assert.deepEqual(await tool(name, args), { isError: true, json: { error: expected } }, name)
      assert.deepEqual(await rest(path, args), { status: 400, json: { error: expected } }, path)
    }
  }

  await check('a :batch model named in the call is refused by both writers, a routing variant after it too',
    () => both('openai/gpt-4o-mini:batch:nitro', words('openai/gpt-4o-mini:batch:nitro', 'openai/gpt-4o-mini:nitro')))
  await check('a :batch default saved on the sheet is refused by both writers', async () => {
    db.prepare('UPDATE sheets SET default_ai_model = ? WHERE id = ?').run('google/gemini-2.5-flash:batch', sid)
    await both(undefined, words('google/gemini-2.5-flash:batch', 'google/gemini-2.5-flash'))
  })

  await client.close()
  server.close()
}

main()
  .catch(e => { failures++; console.log('FAIL threw', e) })
  .finally(() => {
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
    console.log('All ai-batch-writers assertions passed.')
    process.exit(0)
  })
