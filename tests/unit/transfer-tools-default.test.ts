// transfer_rows and transform_column are there on a server started with no
// setting: MCP tools/list holds both, last, in the fixed order (after
// manage_view), transform_column saying a moved pass that had done no rows
// still takes a call without cursor; the REST transfer route answers through the real /api/v1
// router and a real access token, and copies the row; the OpenAPI document
// lists the route.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { v4 as uuid } from 'uuid'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import tokenMod from '../../server/src/lib/access-token'
import mcpMod from '../../server/src/mcp/build-server'
import v1Mod from '../../server/src/routes/api-v1'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { generateAccessToken } = tokenMod as typeof import('../../server/src/lib/access-token')
const { buildMcpServer } = mcpMod as typeof import('../../server/src/mcp/build-server')
const { default: v1Router } = v1Mod as unknown as { default: express.Router }

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const uid = uuid(), tid = uuid(), src = uuid(), dest = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
const sheet = db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,?,?)')
sheet.run(src, tid, uid, 'From', 0, JSON.stringify(['Name']))
sheet.run(dest, tid, uid, 'To', 1, JSON.stringify(['Name']))
const rowId = uuid()
db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  .run(rowId, src, uid, 0, JSON.stringify({ Name: 'Ada' }))
const minted = generateAccessToken()
db.prepare(`INSERT INTO access_tokens (id, user_id, name, token_hash, token_prefix, scopes)
  VALUES (?,?,?,?,?,?)`).run(uuid(), uid, 'unit', minted.tokenHash, minted.tokenPrefix, 'read,write')

async function main() {
  await check('MCP tools/list holds transfer_rows and transform_column, last, after manage_view', async () => {
    const mcp = buildMcpServer({ userId: uid, tokenId: 't', tokenName: 'n', scopes: new Set(['read']) })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await mcp.connect(serverSide)
    const client = new Client({ name: 'unit', version: '1.0.0' })
    await client.connect(clientSide)
    const tools = (await client.listTools()).tools
    const names = tools.map(t => t.name)
    assert.deepEqual(names.slice(-3), ['manage_view', 'transfer_rows', 'transform_column'])
    assert.match(tools.at(-1)!.description ?? '', /refused until restart: true, unless it had done no rows\./)
    assert.equal(new Set(names).size, names.length, 'no tool is listed twice')
    await client.close()
  })

  const app = express()
  app.use('/api/v1', v1Router)
  // Only this machine can reach it; the port is read once it listens.
  const http = app.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/api/v1`
  const auth = { authorization: `Bearer ${minted.token}` }

  await check('REST: POST /sheets/:sourceId/rows/transfer answers and copies the row', async () => {
    const res = await fetch(`${base}/sheets/${src}/rows/transfer`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': uuid() },
      body: JSON.stringify({ destination_sheet_id: dest, operation: 'copy', selection: { row_ids: [rowId] } }),
    })
    const text = await res.text()
    assert.equal(res.status, 200, text)
    assert.deepEqual(db.prepare('SELECT data FROM rows WHERE sheet_id = ?').pluck().all(dest), ['{"Name":"Ada"}'])
  })

  await check('REST: the OpenAPI document lists the transfer route', async () => {
    const res = await fetch(`${base}/openapi.json`, { headers: auth })
    assert.equal(res.status, 200)
    const doc = await res.json() as { paths: Record<string, Record<string, { operationId: string }>> }
    assert.equal(doc.paths['/sheets/{sourceId}/rows/transfer']?.post?.operationId, 'transferRows')
  })

  http.close()
}

main()
  .catch(e => { failures++; console.log('FAIL threw', e) })
  .finally(() => {
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
    console.log('All transfer-tools-default assertions passed.')
    process.exit(0)
  })
