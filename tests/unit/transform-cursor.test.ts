// transform_column's per-call limits (services/column-transform.ts): a call
// stopped by its time budget or its row cap keeps the rows it wrote and answers
// next_cursor with a note; the same call with that cursor goes on, so a
// transform that reads its own target still changes each row once. After a
// sort, the pass's cursor and every other call into its column are refused,
// naming the rows done; a cursor no call gave is refused; a busy sheet is
// refused.
// A finished call answers {updated, created_column} as before. A new target
// column that got no value is listed: the app, REST and MCP show it, and its
// cells read as empty, with nothing stored in the rows.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { v4 as uuid } from 'uuid'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import transformMod from '../../server/src/services/column-transform'
import constMod from '../../server/src/lib/api-v1-constants'
import sortMod from '../../server/src/services/sheet-sort'
import busyMod from '../../server/src/lib/sheet-busy'
import authMod from '../../server/src/lib/auth'
import cookieMod from '../../server/src/lib/cookie'
import mcpMod from '../../server/src/mcp/build-server'
import sheetsMod from '../../server/src/routes/api-v1-sheets'
import appReadMod from '../../server/src/routes/sheets-read'
import { malformed, moved } from './transform-pass-words'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { transformColumn, TRANSFORM_STOPPED_NOTE } =
  transformMod as typeof import('../../server/src/services/column-transform')
const { TRANSFORM_MAX_CALL_MS, TRANSFORM_MAX_ROWS } = constMod as typeof import('../../server/src/lib/api-v1-constants')
const { physicalSortSheet } = sortMod as typeof import('../../server/src/services/sheet-sort')
const { withSheetBusy } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { signToken } = authMod as typeof import('../../server/src/lib/auth')
const { SESSION_COOKIE_NAME } = cookieMod as typeof import('../../server/src/lib/cookie')
const { buildMcpServer } = mcpMod as typeof import('../../server/src/mcp/build-server')
const { default: v1Sheets } = sheetsMod as unknown as { default: express.Router }
const { default: appRead } = appReadMod as unknown as { default: express.Router }

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}
const realNow = Date.now
let shiftMs = 0
Date.now = () => realNow() + shiftMs

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const ROWS = 25_000
const uid = uuid(), tid = uuid(), big = uuid(), small = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
const addSheet = db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,?,?)')
addSheet.run(big, tid, uid, 'Big', 0, JSON.stringify(['N']))
addSheet.run(small, tid, uid, 'Small', 1, JSON.stringify(['Name']))
const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
db.transaction(() => {
  for (let i = 0; i < ROWS; i++) insert.run(uuid(), big, uid, i, JSON.stringify({ N: `r${i}` }))
  for (let i = 0; i < 3; i++) insert.run(uuid(), small, uid, i, JSON.stringify({ Name: `s${i}` }))
})()
// Appends "x" to N: reading its own target, a row changed twice would end "xx".
const again = { sheetId: big, operation: 'template' as const, template: '{{N}}x', targetColumn: 'N' }
// A call whose time budget runs out after its first pages.
async function cutShort(cursor?: string) {
  const call = transformColumn(uid, { ...again, ...(cursor ? { cursor } : {}) })
  setImmediate(() => { shiftMs += TRANSFORM_MAX_CALL_MS })
  return call
}

async function main() {
  await check('a call its time budget stops keeps its rows and answers next_cursor and the note; the calls after it '
    + 'go on, and every row changes once', async () => {
    const first = await cutShort()
    assert.ok('ok' in first, JSON.stringify(first))
    assert.deepEqual(Object.keys(first.ok), ['updated', 'created_column', 'next_cursor', 'note'])
    assert.ok(first.ok.updated > 0 && first.ok.updated < TRANSFORM_MAX_ROWS, String(first.ok.updated))
    assert.match(first.ok.next_cursor!, /^\d+:\d+:[0-9a-f]{12}$/)
    assert.equal(first.ok.note, TRANSFORM_STOPPED_NOTE)
    assert.equal(first.ok.note, "Stopped at this call's limit (10,000 rows written or about 2 seconds of work). "
      + 'The rows before next_cursor are done: call transform_column again with the same arguments and cursor set '
      + 'to next_cursor to go on.')
    const updated = [first.ok.updated]
    for (let cursor = first.ok.next_cursor; cursor;) {
      const out = await transformColumn(uid, { ...again, cursor })
      assert.ok('ok' in out, JSON.stringify(out))
      updated.push(out.ok.updated)
      cursor = out.ok.next_cursor
    }
    assert.equal(updated.reduce((a, b) => a + b, 0), ROWS)
    const once = db.prepare(`SELECT count(*) FROM rows WHERE sheet_id = ? AND json_extract(data, '$.N') GLOB 'r*x'
      AND json_extract(data, '$.N') NOT GLOB '*xx'`).pluck().get(big)
    assert.equal(once, ROWS)
  })

  await check(`with the clock held still, the row cap stops each call: ${TRANSFORM_MAX_ROWS} rows, then `
    + `${TRANSFORM_MAX_ROWS}, then the rest, every row once`, async () => {
    // The time budget never runs out, however slow the disk: only the row cap stops a call.
    const held = Date.now()
    Date.now = () => held
    try {
      const answers = []
      for (let cursor: string | undefined, n = 0; n === 0 || cursor; n++) {
        const out = await transformColumn(uid, { ...again, template: '{{N}}y', ...(cursor ? { cursor } : {}) })
        assert.ok('ok' in out, JSON.stringify(out))
        answers.push(out.ok)
        cursor = out.ok.next_cursor
      }
      const rest = ROWS - 2 * TRANSFORM_MAX_ROWS
      assert.deepEqual(answers.map(a => a.updated), [TRANSFORM_MAX_ROWS, TRANSFORM_MAX_ROWS, rest])
      assert.deepEqual(answers.map(a => a.note), [TRANSFORM_STOPPED_NOTE, TRANSFORM_STOPPED_NOTE, undefined])
    } finally { Date.now = () => realNow() + shiftMs }
    const once = db.prepare(`SELECT count(*) FROM rows WHERE sheet_id = ? AND json_extract(data, '$.N') GLOB 'r*xy'
      AND json_extract(data, '$.N') NOT GLOB '*yy'`).pluck().get(big)
    assert.equal(once, ROWS)
  })

  await check('a cursor from before a sort, or one no call gave, is refused and writes nothing', async () => {
    const stopped = await cutShort()
    assert.ok('ok' in stopped && stopped.ok.next_cursor)
    const before = db.prepare('SELECT group_concat(data) FROM rows WHERE sheet_id = ?').pluck().get(big)
    assert.ok('ok' in await physicalSortSheet(big, uid, 'N', 'desc'))
    // Rows moved under the pass: its cursor and any other call into N are refused, naming no cursor.
    const noPass = { sheetId: small, operation: 'upper' as const, sourceColumn: 'Name', targetColumn: 'Name' }
    const sent = [stopped.ok.next_cursor, undefined, 'abc', '1', '1:2:3', ''], rows = stopped.ok.updated
    for (const cursor of sent) assert.deepEqual(await transformColumn(uid, { ...again, cursor }), moved('N', rows))
    for (const cursor of sent.slice(2)) assert.deepEqual(await transformColumn(uid, { ...noPass, cursor }), malformed)
    const after = db.prepare('SELECT group_concat(data) FROM rows WHERE sheet_id = ?').pluck().get(big)
    assert.equal((after as string).length, (before as string).length, 'nothing more was written')
  })

  await check('a sheet another heavy operation holds is refused in its words', async () => {
    let release!: () => void
    const held = withSheetBusy(small, 'sorting', () => new Promise<void>(r => { release = r }))
    assert.deepEqual(await transformColumn(uid, { sheetId: small, operation: 'upper', sourceColumn: 'Name',
      targetColumn: 'Loud' }), { fail: 'busy', error: 'This sheet is busy sorting. Try again when that finishes.' })
    release()
    await held
  })

  await check('a finished call answers {updated, created_column}, in that order', async () => {
    const out = await transformColumn(uid, { sheetId: small, operation: 'upper', sourceColumn: 'Name',
      targetColumn: 'Loud' })
    assert.deepEqual(out, { ok: { updated: 3, created_column: 'Loud' } })
    assert.deepEqual(Object.keys((out as { ok: object }).ok), ['updated', 'created_column'])
  })

  await check('a new column no row got a value in: listed over the app, REST and MCP, read as empty', async () => {
    const out = await transformColumn(uid, { sheetId: small, operation: 'upper', sourceColumn: 'Name',
      targetColumn: 'Blank', where: [{ column: 'Name', operator: 'eq', value: 'nobody' }] })
    assert.deepEqual(out, { ok: { updated: 0, created_column: 'Blank' } })
    assert.equal(db.prepare(`SELECT count(*) FROM rows WHERE sheet_id = ? AND json_extract(data, '$.Blank')
      IS NOT NULL`).pluck().get(small), 0, 'no row stores it')
    const app = express()
    app.use(express.json())
    app.use('/api/sheets', (req, _res, next) => {
      Object.assign(req, { cookies: { [SESSION_COOKIE_NAME]: signToken({ userId: uid, sessionEpoch: 0 }) } }); next()
    }, appRead)
    app.use('/api/v1', (req, _res, next) => {
      Object.assign(req, { userId: uid, tokenScopes: new Set(['read']) }); next()
    }, v1Sheets)
    // Only this machine can reach it; the port is read once it listens.
    const server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const json = async (path: string, body?: unknown) => (await fetch(`${base}${path}`, body === undefined ? {}
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()
    const empty = { where: [{ column: 'Blank', operator: 'empty' }], return_mode: 'count' }
    assert.deepEqual((await json(`/api/sheets/${small}`)).data.columns, ['Name', 'Loud', 'Blank'])
    assert.deepEqual((await json(`/api/v1/sheets/${small}`)).columns, ['Name', 'Loud', 'Blank'])
    assert.equal((await json(`/api/v1/sheets/${small}/rows/query`, empty)).count, 3)
    server.close()
    const mcp = buildMcpServer({ userId: uid, tokenId: 't', tokenName: 'n', scopes: new Set(['read']) })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await mcp.connect(serverSide)
    const client = new Client({ name: 'unit', version: '1.0.0' })
    await client.connect(clientSide)
    const tool = async (name: string, args: object) =>
      JSON.parse((await client.callTool({ name, arguments: { sheet_id: small, ...args } }) as
        { content: Array<{ text: string }> }).content[0].text)
    assert.deepEqual((await tool('get_sheet', {})).columns, ['Name', 'Loud', 'Blank'])
    assert.equal((await tool('read_rows', empty)).count, 3)
    await client.close()
  })
}

main()
  .catch(e => { failures++; console.log('FAIL threw', e) })
  .finally(() => {
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
    console.log('All transform-cursor assertions passed.')
    process.exit(0)
  })
