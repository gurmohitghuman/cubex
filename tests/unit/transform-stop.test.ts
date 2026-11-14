// transform_column when a page fails after others committed
// (services/column-transform.ts, column-transform-passes.ts). The call answers
// an error carrying next_cursor and rows_done, in words that say to go on with
// that cursor; data_version moves for the pages written; the same call without
// cursor is refused, also from a fresh process, and writes nothing; going on
// with the cursor applies the operation to every row exactly once, and the
// pass's record goes. A first page that fails answers as before, and the
// column the call added stays, with data_version moved. So does a page that
// fails before the pass wrote any row (a where matching only later rows): no
// "after 0 rows", no record, and the same call then runs.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { v4 as uuid } from 'uuid'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import transformMod from '../../server/src/services/column-transform'
import mcpMod from '../../server/src/mcp/build-server'
import { transformPageFault } from './transform-page-fault'
import { unfinished } from './transform-pass-words'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { transformColumn } = transformMod as typeof import('../../server/src/services/column-transform')
const { buildMcpServer } = mcpMod as typeof import('../../server/src/mcp/build-server')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}
const requireHere = createRequire(import.meta.url)

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const ROWS = 1000
const uid = uuid(), tid = uuid(), sid = uuid(), fresh = uuid(), late = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
const addSheet = db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,?,?)')
addSheet.run(sid, tid, uid, 'S', 0, JSON.stringify(['T']))
addSheet.run(fresh, tid, uid, 'F', 1, JSON.stringify(['T']))
addSheet.run(late, tid, uid, 'L', 2, JSON.stringify(['T', 'K']))
const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
db.transaction(() => {
  for (let i = 0; i < ROWS; i++) insert.run(uuid(), sid, uid, i, JSON.stringify({ T: `t${i}` }))
  for (let i = 0; i < 300; i++) insert.run(uuid(), fresh, uid, i, JSON.stringify({ T: `f${i}` }))
  // Only rows 300 on match the where below: the first page writes none.
  for (let i = 0; i < 600; i++) insert.run(uuid(), late, uid, i, JSON.stringify({ T: `l${i}`, K: i < 300 ? 'n' : 'y' }))
}).immediate()
// Reads its own target: a row the operation reached twice ends "-x-x".
const again = { sheetId: sid, operation: 'template' as const, template: '{{T}}-x', targetColumn: 'T' }
const dataVersion = (id: string) => db.prepare('SELECT data_version FROM sheets WHERE id = ?').pluck().get(id) as number
const cells = () => db.prepare('SELECT group_concat(data) FROM rows WHERE sheet_id = ?').pluck().get(sid) as string
const suffixed = (glob: string) => db.prepare(`SELECT count(*) FROM rows WHERE sheet_id = ?
  AND json_extract(data, '$.T') GLOB ?`).pluck().get(sid, glob) as number

const fault = transformPageFault(db)

const mcp = buildMcpServer({ userId: uid, tokenId: 't', tokenName: 'n', scopes: new Set(['read', 'write']) })
const client = new Client({ name: 'unit', version: '1.0.0' })
const transform = async (args: Record<string, unknown>) => await client.callTool({ name: 'transform_column',
  arguments: args }) as { isError?: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] }
const refusal = (cursor: string) => unfinished('T', 250, cursor)
let cursor = ''

async function main() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await mcp.connect(serverSide)
  await client.connect(clientSide)

  await check('a second page that throws: an error with next_cursor and rows_done, in words that say to go on '
    + 'with it; the first page stays written and data_version moved', async () => {
    const before = dataVersion(sid)
    fault.arm(251)
    const out = await transform({ sheet_id: sid, operation: 'template', template: '{{T}}-x', target_column: 'T' })
    fault.disarm()
    assert.equal(out.isError, true)
    const s = out.structuredContent!
    assert.deepEqual(Object.keys(s), ['error', 'next_cursor', 'rows_done', 'changed'])
    assert.deepEqual(JSON.parse(out.content[0].text), s, 'the text mirrors the structured content')
    // The rows it wrote stay written: changed names them.
    const [item, ...more] = s.changed as Array<{ sheet_id: string; columns: string[]; rows: number }>
    assert.deepEqual([item.sheet_id, item.columns, item.rows, more.length], [sid, ['T'], 250, 0])
    cursor = s.next_cursor as string
    assert.match(cursor, /^0:249:[0-9a-f]{12}$/)
    assert.equal(s.rows_done, 250)
    assert.equal(s.error, 'Stopped on an error after 250 rows: something went wrong. Those rows are written. '
      + `Call transform_column again with the same arguments and cursor set to "${cursor}" to go on. Don't start `
      + 'over without cursor: that would apply the operation to those rows again.')
    assert.ok(!out.content[0].text.includes('disk on fire'), 'the error itself is never shown')
    assert.equal(suffixed('t*-x'), 250, 'the first page is written, the failed one rolled back')
    assert.ok(dataVersion(sid) > before, 'data_version moved')
  })

  await check('the same call without cursor is refused in its words, with next_cursor and rows_done, and writes '
    + 'nothing', async () => {
    const before = { cells: cells(), version: dataVersion(sid) }
    assert.deepEqual(await transformColumn(uid, again), refusal(cursor))
    const viaMcp = await transform({ sheet_id: sid, operation: 'template', template: '{{T}}-x', target_column: 'T' })
    assert.equal(viaMcp.isError, true)
    const s = viaMcp.structuredContent!
    assert.deepEqual(Object.keys(s), ['error', 'next_cursor', 'rows_done', 'changed'])
    assert.deepEqual(s, { error: refusal(cursor).unfinished.error, next_cursor: cursor, rows_done: 250, changed: [] })
    assert.deepEqual(JSON.parse(viaMcp.content[0].text), s, 'the text mirrors the structured content')
    assert.deepEqual({ cells: cells(), version: dataVersion(sid) }, before)
  })

  await check('a fresh process opening the database refuses it too', async () => {
    const code = `require(${JSON.stringify(requireHere.resolve('tsx/cjs/api'))}).register();
      const { transformColumn } = require(${JSON.stringify(requireHere.resolve(
        '../../server/src/services/column-transform'))});
      transformColumn(${JSON.stringify(uid)}, ${JSON.stringify(again)})
        .then(r => { console.log('ANSWER ' + JSON.stringify(r)); process.exit(0) });`
    const child = spawn(process.execPath, ['-e', code], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', chunk => { out += chunk })
    assert.equal(await new Promise(resolve => child.on('close', resolve)), 0, out)
    const answer = /^ANSWER (.*)$/m.exec(out)
    assert.ok(answer, out)
    assert.deepEqual(JSON.parse(answer[1]), refusal(cursor))
    assert.equal(suffixed('t*-x'), 250)
  })

  await check('going on with the cursor applies the operation to every row exactly once; the record goes',
    async () => {
      const out = await transformColumn(uid, { ...again, cursor })
      assert.deepEqual(out, { ok: { updated: ROWS - 250, created_column: null } })
      assert.equal(suffixed('t*-x'), ROWS)
      assert.equal(suffixed('*-x-x'), 0)
      assert.equal(db.prepare('SELECT count(*) FROM transform_passes WHERE sheet_id = ?').pluck().get(sid), 0)
    })

  await check('a first page that throws answers as before and writes no cell; the column it added stays and '
    + 'data_version moved; the same call then runs', async () => {
    const before = dataVersion(fresh)
    fault.arm(1)
    const out = await transform({ sheet_id: fresh, operation: 'upper', source_column: 'T', target_column: 'Up' })
    fault.disarm()
    assert.deepEqual(out, { content: [{ type: 'text',
      text: JSON.stringify({ error: 'Something went wrong handling that request. Please try again.' }) }],
    isError: true })
    assert.equal(db.prepare(`SELECT count(*) FROM rows WHERE sheet_id = ? AND json_extract(data, '$.Up')
      IS NOT NULL`).pluck().get(fresh), 0)
    assert.deepEqual(JSON.parse(db.prepare('SELECT column_order FROM sheets WHERE id = ?').pluck()
      .get(fresh) as string), ['T', 'Up'])
    assert.ok(dataVersion(fresh) > before, 'data_version moved for the column added')
    assert.deepEqual(await transformColumn(uid, { sheetId: fresh, operation: 'upper', sourceColumn: 'T',
      targetColumn: 'Up' }), { ok: { updated: 300, created_column: null } })
  })

  await check('a page that fails before the pass wrote any row answers as a first page does: no record, and the '
    + 'same call then runs', async () => {
    const call = { sheet_id: late, operation: 'template', template: '{{T}}-x', target_column: 'T',
      where: [{ column: 'K', operator: 'eq', value: 'y' }] }
    fault.arm(1)
    const out = await transform(call)
    fault.disarm()
    assert.deepEqual(out, { content: [{ type: 'text',
      text: JSON.stringify({ error: 'Something went wrong handling that request. Please try again.' }) }],
    isError: true })
    assert.equal(db.prepare('SELECT count(*) FROM transform_passes WHERE sheet_id = ?').pluck().get(late), 0)
    const { changed, ...ran } = JSON.parse((await transform(call)).content[0].text)
    assert.deepEqual(ran, { updated: 300, created_column: null })
    assert.deepEqual(changed.map((i: { columns: string[]; rows: number }) => [i.columns, i.rows]), [[['T'], 300]])
    assert.equal(db.prepare(`SELECT count(*) FROM rows WHERE sheet_id = ? AND json_extract(data, '$.T') GLOB '*-x'`)
      .pluck().get(late), 300)
  })
  await client.close()
}

main()
  .catch(e => { failures++; console.log('FAIL threw', e) })
  .finally(() => {
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
    console.log('All transform-stop assertions passed.')
    process.exit(0)
  })
