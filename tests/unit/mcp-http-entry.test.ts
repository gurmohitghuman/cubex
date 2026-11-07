// /mcp's era router (server/src/mcp/http-entry.ts), driven in process. A request
// with the 2026-07-28 _meta goes to the SDK's modern handler: server/discover and
// tools/list carry Cubex's cache hints (5 minutes, private), tools say
// listChanged false (a subscriptions/listen is acknowledged empty and closed),
// tools/list keeps registration order. A 2025-era request (initialize, or a
// plain request) gets the stateless transport's single JSON body, as before.
// A notification gets 202 and no body in both eras. The caller rides in
// authInfo; without it nothing is served. Refusals and errors:
// mcp-http-entry-errors.test.ts.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { mcpHttpKit, MODERN, SERVER, META } from './mcp-http-kit'
import buildMod from '../../server/src/mcp/build-server'
import spendMod from '../../server/src/lib/token-spend'
const { registerAllTools } = buildMod as typeof import('../../server/src/mcp/build-server')
const { capToolNote } = spendMod as typeof import('../../server/src/lib/token-spend')

const { ctx, spend, check, done, crash, post, modern, legacy } = mcpHttpKit('mcp-http-entry')

// The order registerAllTools registers in (as openapi/tool-schemas.ts reads it).
const registered: string[] = []
registerAllTools({ registerTool: (name: string) => { registered.push(name) } } as never, ctx)

async function main() {
  await check('server/discover: 2026-07-28, listChanged false, the token\'s instructions, private for 5 minutes',
    async () => {
      const res = await modern('server/discover')
      assert.deepEqual([res.status, res.type], [200, 'application/json'])
      const { result } = JSON.parse(res.text)
      assert.deepEqual(result.supportedVersions, [MODERN])
      assert.deepEqual(result.capabilities, { tools: { listChanged: false } })
      assert.ok(result.instructions.startsWith('Cubex is a spreadsheet workspace.'))
      assert.ok(result.instructions.endsWith(capToolNote(spend, true)))
      assert.deepEqual([result.resultType, result.ttlMs, result.cacheScope], ['complete', 300_000, 'private'])
      assert.deepEqual(result._meta, SERVER)
    })

  await check('tools/list: registration order on every call, private for 5 minutes', async () => {
    for (let call = 0; call < 2; call++) {
      const { result } = JSON.parse((await modern('tools/list')).text)
      assert.deepEqual(result.tools.map((t: { name: string }) => t.name), registered)
      assert.deepEqual([result.resultType, result.ttlMs, result.cacheScope, result.nextCursor],
        ['complete', 300_000, 'private', undefined])
      assert.deepEqual(result._meta, SERVER)
    }
  })

  await check('tools/call: a read works, a write is refused as isError naming the scope', async () => {
    const okRes = JSON.parse((await modern('tools/call', { name: 'list_tables', arguments: {} }, 'list_tables')).text)
    assert.equal(okRes.result.isError, undefined)
    assert.deepEqual([okRes.result.resultType, okRes.result._meta], ['complete', SERVER])
    const refused = JSON.parse((await modern('tools/call',
      { name: 'append_rows', arguments: { sheet_id: uuid(), rows: [{ a: '1' }] } }, 'append_rows')).text)
    assert.equal(refused.result.isError, true)
    assert.deepEqual(JSON.parse(refused.result.content[0].text),
      { error: "This action requires the 'write' scope on your Cubex access token." })
  })

  await check('subscriptions/listen: acknowledged with nothing, then closed at once', async () => {
    const res = await modern('subscriptions/listen', { notifications: { toolsListChanged: true } })
    assert.deepEqual([res.status, res.type], [200, 'text/event-stream'])
    const frames = res.text.trim().split('\n\n').map(f => JSON.parse(f.replace(/^event: message\ndata: /, '')))
    assert.deepEqual(frames.map(f => f.method ?? f.result?.resultType),
      ['notifications/subscriptions/acknowledged', 'complete'])
    assert.deepEqual(frames[0].params.notifications, {})
  })

  await check('2025-era initialize: one JSON body, 2025-11-25, listChanged false, no 2026 fields', async () => {
    const res = await legacy('initialize',
      { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'unit', version: '1' } })
    assert.deepEqual([res.status, res.type], [200, 'application/json'])
    const { result } = JSON.parse(res.text)
    assert.deepEqual(Object.keys(result).sort(), ['capabilities', 'instructions', 'protocolVersion', 'serverInfo'])
    assert.deepEqual([result.protocolVersion, result.capabilities, result.serverInfo],
      ['2025-11-25', { tools: { listChanged: false } }, SERVER['io.modelcontextprotocol/serverInfo']])
  })

  await check('2025-era tools/list and tools/call: JSON, the same tools, no resultType or cache fields', async () => {
    const list = await legacy('tools/list')
    assert.deepEqual([list.status, list.type], [200, 'application/json'])
    const { result } = JSON.parse(list.text)
    assert.deepEqual(Object.keys(result), ['tools'])
    assert.deepEqual(result.tools.map((t: { name: string }) => t.name), registered)
    const call = JSON.parse((await legacy('tools/call', { name: 'list_tables', arguments: {} })).text)
    assert.equal(call.result.resultType, undefined)
    assert.ok(Array.isArray(call.result.structuredContent.tables))
  })

  await check('a notification is accepted with 202 and no body, in both eras', async () => {
    const legacyNote = await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const modernNote = await post({ jsonrpc: '2.0', method: 'notifications/cancelled',
      params: { requestId: 1, _meta: META } }, { 'mcp-protocol-version': MODERN })
    for (const res of [legacyNote, modernNote]) assert.deepEqual([res.status, res.text], [202, ''])
  })

  await check('without a caller nothing is served (the route always sets one)', async () => {
    const quiet = console.error
    console.error = () => {}
    try {
      const res = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META } },
        { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list' }, false)
      assert.deepEqual([res.status, JSON.parse(res.text).error.code], [500, -32603])
      await assert.rejects(post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, {}, false),
        { message: 'MCP request without a signed-in token' })
    } finally { console.error = quiet }
  })

  done()
}

main().catch(crash)
