// max_chars_per_cell as the two surfaces send it: MCP read_rows (the real
// server, in memory) and REST POST /api/v1/sheets/:id/rows/query (the real
// router). Without the option every read keeps its keys in order: the answer's
// and each row's, for a page, a filtered page, a view, row_ids and
// updated_since. With it, cut_cells is {"<row id>": {"<column>": full
// length}} on both, columns named "__proto__" and "constructor" included as
// plain keys. MCP publishes the field as an integer from 1 to 200000 and
// answers every value it refuses (a wrong type included) as an isError tool
// result carrying the words REST answers with a 400. Both take the same digits
// sent as text as the number. groups refused in one round on both. The
// services: read-max-chars.test.ts.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { v4 as uuid } from 'uuid'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import viewsMod from '../../server/src/services/views'
import mcpMod from '../../server/src/mcp/build-server'
import sheetsMod from '../../server/src/routes/api-v1-sheets'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { createView } = viewsMod as typeof import('../../server/src/services/views')
const { buildMcpServer } = mcpMod as typeof import('../../server/src/mcp/build-server')
const { default: sheetsRouter } = sheetsMod as unknown as { default: express.Router }

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
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
  .run(sid, tid, uid, 'S', JSON.stringify(['Name', 'Notes', '__proto__', 'constructor']))
const ROWS = [
  `{"Name":"Acme","Notes":"${'n'.repeat(300)}","__proto__":"${'p'.repeat(50)}","constructor":"${'c'.repeat(50)}"}`,
  '{"Name":"Beta","Notes":"short"}', '{"Name":"Gamma"}',
]
const ids = ROWS.map((data, i) => {
  const id = uuid()
  db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)').run(id, sid, uid, i, data)
  return id
})
const [r0, r1] = ids
assert.ok('ok' in createView(sid, uid, { name: 'Named', where: [{ column: 'Name', operator: 'not_empty' }],
  hidden_columns: ['constructor'] }))

const BOUNDS = 'max_chars_per_cell must be an integer from 1 to 200000.'
const REFUSED = { status: 400, text: JSON.stringify({ error: BOUNDS }) }
type Res = { content: Array<{ type: string; text: string }>; isError?: boolean }
type Answer = { rows: Array<{ data: Record<string, unknown> }>; [k: string]: unknown }

async function main() {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { Object.assign(req, { userId: uid, tokenScopes: new Set(['read']) }); next() })
  app.use(sheetsRouter)
  // Only this machine can reach it (every request is signed in); the port is read once it listens.
  const http = app.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
  const mcp = buildMcpServer({ userId: uid, tokenId: 't', tokenName: 'n', scopes: new Set(['read']) })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await mcp.connect(serverSide)
  const client = new Client({ name: 'unit', version: '1.0.0' })
  await client.connect(clientSide)
  // The answer's JSON text as each surface sends it.
  const rest = async (body: Record<string, unknown>) => {
    const res = await fetch(`${base}/sheets/${sid}/rows/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, text: await res.text() }
  }
  const tool = async (args: Record<string, unknown>) =>
    await client.callTool({ name: 'read_rows', arguments: { sheet_id: sid, ...args } }) as Res
  const both = async (args: Record<string, unknown>) => {
    const viaRest = await rest(args), viaMcp = await tool(args)
    assert.equal(viaRest.status, 200, viaRest.text)
    assert.ok(!viaMcp.isError, viaMcp.content[0].text)
    return [JSON.parse(viaRest.text), JSON.parse(viaMcp.content[0].text)] as Answer[]
  }

  try {
    await check('without the option: the answer\'s keys and each row\'s, in order, on both surfaces', async () => {
      const page = ['rows', 'next_cursor', 'data_version', 'row_generation']
      const plainRow = ['id', 'index', 'data'], timedRow = ['id', 'index', 'updated_at', 'data']
      const all = ['Name', 'Notes', '__proto__', 'constructor']
      const shapes: Array<[string, Record<string, unknown>, string[], string[], string[][]]> = [
        ['page', {}, page, plainRow, [all, ['Name', 'Notes'], ['Name']]],
        ['filtered page', { where: [{ column: 'Notes', operator: 'not_empty' }], limit: 1 }, page, plainRow, [all]],
        ['view', { view: 'Named' }, [...page, 'view_version'], plainRow,
          [['Name', 'Notes', '__proto__'], ['Name', 'Notes', '__proto__'], ['Name', 'Notes', '__proto__']]],
        ['row_ids', { row_ids: [r1, r0] }, ['rows', 'missing', 'data_version', 'row_generation'], timedRow,
          [['Name', 'Notes'], all]],
        ['updated_since', { updated_since: '2000-01-01T00:00:00Z' },
          ['rows', 'next_cursor', 'as_of', 'filling', 'data_version', 'row_generation'], timedRow,
          [all, ['Name', 'Notes'], ['Name']]],
      ]
      for (const [name, args, top, rowKeys, dataKeys] of shapes) {
        for (const [surface, answer] of (await both(args)).map((a, i) => [i ? 'MCP' : 'REST', a] as const)) {
          const at = `${surface} ${name}`
          assert.deepEqual(Object.keys(answer), top, at)
          assert.deepEqual(answer.rows.map(r => Object.keys(r)), dataKeys.map(() => rowKeys), at)
          assert.deepEqual(answer.rows.map(r => Object.keys(r.data)), dataKeys, at)
        }
      }
    })

    await check('with it: cut_cells by row id, then column; "__proto__", "constructor" plain keys', async () => {
      const wanted = `"cut_cells":{"${r0}":{"Notes":300,"__proto__":50,"constructor":50}}`
      const viaRest = await rest({ max_chars_per_cell: 10 }), viaMcp = await tool({ max_chars_per_cell: 10 })
      assert.ok(viaRest.text.includes(`}],${wanted},"next_cursor"`), viaRest.text)
      assert.ok(viaMcp.content[0].text.includes(wanted), viaMcp.content[0].text)
      const [a, b] = await both({ max_chars_per_cell: 10 })
      assert.deepEqual(a, b)
      const cut = (a.cut_cells as Record<string, Record<string, number>>)[r0]
      assert.deepEqual(Object.keys(cut), ['Notes', '__proto__', 'constructor'])
      assert.equal(Object.getPrototypeOf(cut), Object.prototype, 'a plain key, not a prototype')
      assert.deepEqual(a.rows[0].data, JSON.parse(`{"Name":"Acme","Notes":"${'n'.repeat(10)}",`
        + `"__proto__":"${'p'.repeat(10)}","constructor":"${'c'.repeat(10)}"}`))
      // Nothing cut: {} on both; picks named after them listed the same way.
      for (const answer of await both({ max_chars_per_cell: 200_000 })) assert.deepEqual(answer.cut_cells, {})
      const columns = [{ column: 'Notes', as: 'constructor' }, { column: 'Name', as: '__proto__' }]
      const picked = await both({ columns, max_chars_per_cell: 3 })
      for (const answer of picked) {
        assert.equal(JSON.stringify(answer.cut_cells), `{"${r0}":{"constructor":300,"__proto__":4},`
          + `"${r1}":{"constructor":5,"__proto__":4},"${ids[2]}":{"__proto__":5}}`)
      }
    })

    await check('MCP publishes an integer from 1 to 200000', async () => {
      const { tools } = await client.listTools()
      const field = tools.find(t => t.name === 'read_rows')!.inputSchema.properties!.max_chars_per_cell as
        Record<string, unknown>
      assert.deepEqual([field.type, field.minimum, field.maximum], ['integer', 1, 200_000])
    })

    await check('MCP refuses every bad value as an isError result with the REST words',
      async () => {
        for (const bad of [0, -1, 1.5, 200_001, true, 'abc', null, '1.5', '']) {
          // A JSON-RPC error would throw here: it resolves to a tool result.
          const res = await tool({ max_chars_per_cell: bad })
          assert.equal(res.isError, true, JSON.stringify(bad))
          assert.ok(res.content[0].text.includes(BOUNDS), `${JSON.stringify(bad)}: ${res.content[0].text}`)
          assert.ok(res.content[0].text.includes('Input validation error'), res.content[0].text)
          assert.deepEqual(await rest({ max_chars_per_cell: bad }), REFUSED, `REST ${JSON.stringify(bad)}`)
        }
      })

    await check('digits sent as text: the same strings count as the number on both surfaces, others refused',
      async () => {
        const asNumber = JSON.parse((await tool({ max_chars_per_cell: 12 })).content[0].text) as Answer
        assert.equal(asNumber.rows[0].data.Notes, 'n'.repeat(12))
        for (const text of ['12', '0012', ' 12', '12\n', '\t12 ']) {
          const viaMcp = await tool({ max_chars_per_cell: text }), viaRest = await rest({ max_chars_per_cell: text })
          assert.ok(!viaMcp.isError, viaMcp.content[0].text)
          assert.deepEqual(JSON.parse(viaMcp.content[0].text), asNumber, `MCP ${JSON.stringify(text)}`)
          assert.equal(viaRest.status, 200, `REST ${JSON.stringify(text)}: ${viaRest.text}`)
          assert.deepEqual(JSON.parse(viaRest.text), asNumber, `REST ${JSON.stringify(text)}`)
        }
        for (const text of ['1.5', '1e3', '0x10', '-3', '+12', '12a', '1 2', '', '0', '200001']) {
          const viaMcp = await tool({ max_chars_per_cell: text })
          assert.equal(viaMcp.isError, true, `MCP ${JSON.stringify(text)}`)
          assert.ok(viaMcp.content[0].text.includes(BOUNDS), viaMcp.content[0].text)
          assert.deepEqual(await rest({ max_chars_per_cell: text }), REFUSED, `REST ${JSON.stringify(text)}`)
        }
      })

    await check('group_by with columns and max_chars_per_cell: one refusal naming both, on both surfaces', async () => {
      const words = 'group_by and aggregates answer groups, not rows: leave out cursor, limit, columns, return_mode, '
        + 'include_status and max_chars_per_cell.'
      const args = { group_by: ['Name'], columns: ['Name'], max_chars_per_cell: 10 }
      assert.deepEqual(await rest(args), { status: 400, text: JSON.stringify({ error: words }) })
      const res = await tool(args)
      assert.equal(res.isError, true)
      assert.deepEqual(JSON.parse(res.content[0].text), { error: words })
      assert.ok(!(await tool({ group_by: ['Name'] })).isError)
    })
  } finally {
    await client.close()
    await mcp.close()
    await new Promise(resolve => http.close(resolve))
  }

  if (failures) { console.error(`${failures} read-max-chars-surfaces check(s) failed`); process.exit(1) }
  console.log('All read-max-chars-surfaces assertions passed.')
}

main().catch(e => { console.error(e); process.exit(1) })
