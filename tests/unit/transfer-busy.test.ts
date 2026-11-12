// A transfer into a sheet in the middle of another heavy operation
// (services/rows-transfer.ts), here a CSV import its upload holds between two
// slices until the test lets it go (no sheet big enough to outlast the calls):
// REST POST /api/v1/sheets/:sourceId/rows/transfer answers 409 {error, busy:
// true} and MCP transfer_rows an error, both in the words of the busy check in
// front of every sheet route; nothing is created (no row, no column, no
// idempotency record: the same call once the import is done copies the row).
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
import importMod from '../../server/src/services/csv-import'
import parseMod from '../../server/src/lib/csv-import-parse'
import busyMod from '../../server/src/lib/sheet-busy'
import mcpMod from '../../server/src/mcp/build-server'
import v1Mod from '../../server/src/routes/api-v1'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { generateAccessToken } = tokenMod as typeof import('../../server/src/lib/access-token')
const { importCsv } = importMod as typeof import('../../server/src/services/csv-import')
const { scanCsvText } = parseMod as typeof import('../../server/src/lib/csv-import-parse')
const { sheetBusyWith } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { buildMcpServer } = mcpMod as typeof import('../../server/src/mcp/build-server')
const { default: v1Router } = v1Mod as unknown as { default: express.Router }

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}

const DEST_ROWS = 3
const BUSY = 'This sheet is busy importing. Try again when that finishes.'
const uid = uuid(), tid = uuid(), src = uuid(), dest = uuid(), rowId = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
const sheet = db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,?,?)')
sheet.run(src, tid, uid, 'From', 0, JSON.stringify(['Name', 'Fresh']))
sheet.run(dest, tid, uid, 'To', 1, JSON.stringify(['Name']))
const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
db.transaction(() => {
  insert.run(rowId, src, uid, 0, JSON.stringify({ Name: 'Ada', Fresh: 'new' }))
  for (let i = 0; i < DEST_ROWS; i++) insert.run(uuid(), dest, uid, i, JSON.stringify({ Name: `d${i}` }))
})()
const minted = generateAccessToken()
db.prepare(`INSERT INTO access_tokens (id, user_id, name, token_hash, token_prefix, scopes)
  VALUES (?,?,?,?,?,?)`).run(uuid(), uid, 'unit', minted.tokenHash, minted.tokenPrefix, 'read,write')

async function main() {
  const app = express()
  app.use('/api/v1', v1Router)
  // Only this machine can reach it; the port is read once it listens.
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/sheets/${src}/rows/transfer`
  const key = uuid()
  const body = { destination_sheet_id: dest, operation: 'copy', selection: { row_ids: [rowId] } }
  const rest = async () => {
    const res = await fetch(url, { method: 'POST', body: JSON.stringify(body), headers: {
      authorization: `Bearer ${minted.token}`, 'content-type': 'application/json', 'idempotency-key': key } })
    return { status: res.status, json: await res.json() }
  }
  const mcp = buildMcpServer({ userId: uid, tokenId: 't', tokenName: 'n', scopes: new Set(['read', 'write']) })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await mcp.connect(serverSide)
  const client = new Client({ name: 'unit', version: '1.0.0' })
  await client.connect(clientSide)

  // An import into the destination whose upload waits for `release` before its first row.
  let release!: () => void
  const upload = new Promise<void>(r => { release = r })
  const csv = await scanCsvText('Name\nZed\n')
  const importing = importCsv(dest, uid, { ...csv, rows: async function* () { await upload; yield* csv.rows() } },
    false)
  for (let i = 0; i < 200 && sheetBusyWith(dest) === null; i++) await new Promise(r => setTimeout(r, 5))
  assert.equal(sheetBusyWith(dest), 'importing', 'the destination is importing')
  const refusedRest = await rest()
  const refusedMcp = await client.callTool({ name: 'transfer_rows', arguments: { source_sheet_id: src,
    destination_sheet_id: dest, operation: 'copy', selection: { row_ids: [rowId] }, idempotency_key: key } }) as
    { isError?: boolean; content: Array<{ text: string }> }
  assert.equal(sheetBusyWith(dest), 'importing', 'still importing when both answered')
  assert.deepEqual(refusedRest, { status: 409, json: { error: BUSY, busy: true } }, 'REST refuses')
  assert.deepEqual([refusedMcp.isError, JSON.parse(refusedMcp.content[0].text)], [true, { error: BUSY }], 'MCP')
  assert.equal(db.prepare('SELECT count(*) FROM rows WHERE sheet_id = ?').pluck().get(dest), DEST_ROWS, 'no row')
  assert.equal(db.prepare('SELECT column_order FROM sheets WHERE id = ?').pluck().get(dest), '["Name"]', 'no column')
  release()
  const imported = await importing
  assert.ok('ok' in imported && imported.ok.rowsImported === 1, JSON.stringify(imported))

  const after = await rest()
  assert.deepEqual([after.status, after.json.copied, after.json.created_columns, after.json.replayed],
    [200, 1, ['Fresh'], false], 'once imported, the same call copies (no record was kept)')
  console.log('ok   REST and MCP refuse a transfer into a sheet that is importing; nothing is created')

  await client.close()
  server.close()
}

main()
  .then(() => { console.log('All transfer-busy assertions passed.'); process.exit(0) })
  .catch(e => { console.log('FAIL', e); process.exit(1) })
