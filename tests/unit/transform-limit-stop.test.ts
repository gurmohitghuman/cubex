// A transform_column pass stopped at its call's limit is unfinished
// (services/column-transform-passes.ts). A template over 10,001 rows stops at
// the 10,000-row limit: the same call without cursor is refused over MCP, with
// next_cursor, rows_done and words naming restart, and writes nothing; going on
// with the cursor ends every row exactly once. A pass stopped by the time
// limit refuses the same way. restart: true starts over from the first row,
// its pass counting only its own rows, and restart with a cursor is refused.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import constMod from '../../server/src/lib/api-v1-constants'
import mcpMod from '../../server/src/mcp/build-server'
import walMod from '../../server/src/lib/wal-checkpointer'
import { unfinished } from './transform-pass-words'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { TRANSFORM_MAX_CALL_MS } = constMod as typeof import('../../server/src/lib/api-v1-constants')
const { buildMcpServer } = mcpMod as typeof import('../../server/src/mcp/build-server')
const { checkpointInBackground } = walMod as typeof import('../../server/src/lib/wal-checkpointer')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}
// frozen: the clock stands still during a call, so only the row limit stops it.
const realNow = Date.now
let shiftMs = 0
let frozen: number | null = null
Date.now = () => frozen ?? realNow() + shiftMs

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const ROWS = 10_001
const uid = uuid(), tid = uuid(), sid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,?,?)')
  .run(sid, tid, uid, 'S', 0, JSON.stringify(['T']))
const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
db.transaction(() => {
  for (let i = 0; i < ROWS; i++) insert.run(uuid(), sid, uid, i, JSON.stringify({ T: `t${i}` }))
}).immediate()
// Reads its own target: a row the operation reached twice ends "-x-x".
const call = { sheet_id: sid, operation: 'template', template: '{{T}}-x', target_column: 'T' }
const state = () => db.prepare(`SELECT group_concat(data), (SELECT data_version FROM sheets WHERE id = ?)
  FROM rows WHERE sheet_id = ?`).raw().get(sid, sid)
const valueAt = (i: number) => db.prepare(`SELECT json_extract(data, '$.T') FROM rows WHERE sheet_id = ?
  AND row_index = ?`).pluck().get(sid, i)
const ending = (glob: string) => db.prepare(`SELECT count(*) FROM rows WHERE sheet_id = ?
  AND json_extract(data, '$.T') GLOB ?`).pluck().get(sid, glob) as number
const records = () => db.prepare('SELECT count(*) FROM transform_passes WHERE sheet_id = ?').pluck().get(sid)

const mcp = buildMcpServer({ userId: uid, tokenId: 't', tokenName: 'n', scopes: new Set(['read', 'write']) })
const client = new Client({ name: 'unit', version: '1.0.0' })
type Answer = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] }
async function transform(args: Record<string, unknown>, stop: 'rows' | 'time' = 'rows') {
  // The WAL started over on the worker first: a first page that found every frame copied would await that, and the
  // clock's jump below could land before it.
  if (stop === 'time') await checkpointInBackground()
  frozen = stop === 'rows' ? realNow() : null
  const out = client.callTool({ name: 'transform_column', arguments: args }) as Promise<Answer>
  // The time limit: the clock jumps past it once the call has begun.
  if (stop === 'time') setImmediate(() => { shiftMs += TRANSFORM_MAX_CALL_MS })
  try { return await out } finally { frozen = null }
}
const answer = (out: Answer) => JSON.parse(out.content[0].text) as Record<string, unknown>
async function refusedWith(args: Record<string, unknown>, rows: number, cursor: string) {
  const before = state()
  const out = await transform(args)
  assert.equal(out.isError, true)
  const { error, next_cursor, rows_done } = unfinished('T', rows, cursor).unfinished
  assert.deepEqual(out.structuredContent, { error, next_cursor, rows_done })
  assert.deepEqual(answer(out), out.structuredContent, 'the text mirrors the structured content')
  assert.deepEqual(state(), before, 'nothing was written')
}

async function main() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await mcp.connect(serverSide)
  await client.connect(clientSide)

  await check('stopped at the 10,000-row limit, the same call without cursor is refused and writes nothing; going '
    + 'on with the cursor ends every row exactly once', async () => {
    const first = answer(await transform(call))
    assert.equal(first.updated, 10_000)
    const cursor = first.next_cursor as string
    assert.match(cursor, /^0:9999:[0-9a-f]{12}$/)
    await refusedWith(call, 10_000, cursor)
    assert.deepEqual(answer(await transform({ ...call, cursor })), { updated: 1, created_column: null })
    assert.equal(ending('t*-x'), ROWS)
    assert.equal(ending('*-x-x'), 0)
    assert.equal(records(), 0)
  })

  await check('stopped at the time limit, the same call without cursor is refused; restart with a cursor is '
    + 'refused; restart: true starts over from the first row, its pass counting only its own rows', async () => {
    const cut = answer(await transform(call, 'time'))
    const done = cut.updated as number
    assert.ok(done > 0 && done < 10_000 && cut.next_cursor, JSON.stringify(cut))
    await refusedWith(call, done, cut.next_cursor as string)
    const both = await transform({ ...call, restart: true, cursor: cut.next_cursor })
    assert.equal(both.isError, true)
    assert.deepEqual(answer(both), { error: 'restart and cursor don\'t go together: restart: true starts the '
      + 'column over from the first row, cursor goes on from where a call stopped. Send one of them.' })
    const restarted = answer(await transform({ ...call, restart: true }))
    assert.equal(restarted.updated, 10_000)
    assert.equal(valueAt(0), 't0-x-x-x', 'the first row again: once in each pass and once in the restart')
    assert.equal(valueAt(done), `t${done}-x-x`, 'a row the time-limited call never reached: once by the restart')
    await refusedWith(call, 10_000, restarted.next_cursor as string)
    assert.deepEqual(answer(await transform({ ...call, cursor: restarted.next_cursor })),
      { updated: 1, created_column: null })
    assert.equal(valueAt(ROWS - 1), `t${ROWS - 1}-x-x`)
    assert.equal(records(), 0)
  })
  await client.close()
}

main()
  .catch(e => { failures++; console.log('FAIL threw', e) })
  .finally(() => {
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
    console.log('All transform-limit-stop assertions passed.')
    process.exit(0)
  })
