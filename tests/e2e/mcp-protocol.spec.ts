import { test, expect } from '@playwright/test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { authedApi, seedSheet, BASE, makeAccessToken } from './helpers'

// /mcp on the 2026-07-28 revision, against the built server: the v2 client
// pinned to it, and raw POSTs for what that client keeps to itself (resultType,
// the cache fields, the request headers and the errors). Clients on 2025-11-25
// (initialize first) are mcp.spec.ts, on the v1 client.

const MODERN = '2026-07-28'
const SERVER_INFO = { name: 'cubex', version: '1.0.0' }
const STAMP = { 'io.modelcontextprotocol/serverInfo': SERVER_INFO }
const META = { 'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientInfo': { name: 'e2e-raw', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {} }
const EVERY = [MODERN, '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']
const BOUNDS = 'max_chars_per_cell must be an integer from 1 to 200000.'
const WRITE_REFUSED = { error: "This action requires the 'write' scope on your Cubex access token." }

async function modernClient(token: string): Promise<Client> {
  const client = new Client({ name: 'e2e-modern', version: '1.0.0' }, { versionNegotiation: { mode: { pin: MODERN } } })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }))
  return client
}

const textOf = (res: { content?: unknown }) => (res.content as Array<{ text: string }>)[0].text

// The three request headers a 2026-07-28 POST carries.
const std = (method: string, name?: string) =>
  ({ 'MCP-Protocol-Version': MODERN, 'Mcp-Method': method, ...(name === undefined ? {} : { 'Mcp-Name': name }) })

// One raw POST. `headers` replaces the standard three (pass {} for none); `meta` replaces the envelope
// (null: none at all).
async function raw(token: string | null, method: string, params: Record<string, unknown> = {},
  headers?: Record<string, string>, meta: Record<string, unknown> | null = META) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', ...(headers ?? std(method, params.name as string | undefined)) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 41, method, params: meta ? { ...params, _meta: meta } : params }),
  })
  const text = await res.text()
  const type = res.headers.get('content-type') ?? ''
  return { status: res.status, type, headers: res.headers, text,
    body: type.startsWith('application/json') ? JSON.parse(text) : null }
}

test('MCP 2026-07-28 with the v2 client: discover, a fixed tool list, calls and refusals', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2)
  const rw = await modernClient(await makeAccessToken(api, ['read', 'write'], 'e2e mcp modern rw'))
  const rw2 = await modernClient(await makeAccessToken(api, ['read', 'write'], 'e2e mcp modern rw2'))
  const ro = await modernClient(await makeAccessToken(api, ['read'], 'e2e mcp modern ro'))

  // Connecting pinned to 2026-07-28 is a server/discover, with no initialize.
  expect([rw.getProtocolEra(), rw.getNegotiatedProtocolVersion()]).toEqual(['modern', MODERN])
  expect(rw.getDiscoverResult()?.supportedVersions).toEqual([MODERN])
  expect(rw.getServerVersion()).toEqual(SERVER_INFO)
  expect(rw.getServerCapabilities()).toEqual({ tools: { listChanged: false } })
  expect(rw.getInstructions()).toMatch(/^Cubex is a spreadsheet workspace\./)

  // The same list on every call and for two tokens with the same scopes. A read-only token gets the same
  // tools in the same order: it is refused inside the tools it can't use, never hidden from them (only
  // create_upload_link's description adds that this token can't write).
  const list = async (c: Client) => (await c.listTools({}, { cacheMode: 'bypass' })).tools
  const first = await list(rw)
  expect(first.length).toBeGreaterThan(60)
  for (const again of [await list(rw), await list(rw2)]) expect(again).toEqual(first)
  const readOnly = await list(ro)
  expect(readOnly.map(t => t.name)).toEqual(first.map(t => t.name))
  expect(readOnly.filter((t, i) => JSON.stringify(t) !== JSON.stringify(first[i])).map(t => t.name))
    .toEqual(['create_upload_link'])
  const readRows = first.find(t => t.name === 'read_rows')!
  expect(readRows.inputSchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
  const { type, minimum, maximum } = readRows.inputSchema.properties!.max_chars_per_cell as Record<string, unknown>
  expect({ type, minimum, maximum }).toEqual({ type: 'integer', minimum: 1, maximum: 200_000 })

  // A call that works, one the token's scope refuses and one with a wrong type: both refusals are tool results.
  const read = await rw.callTool({ name: 'read_rows', arguments: { sheet_id: sheetId, limit: 1 } })
  expect(read.isError).toBeFalsy()
  expect((read.structuredContent as { rows: Array<{ data: unknown }> }).rows[0].data).toEqual({ val: 'v0' })
  const refused = await ro.callTool({ name: 'append_rows', arguments: { sheet_id: sheetId, rows: [{ val: 'x' }] } })
  expect(refused.isError).toBe(true)
  expect(JSON.parse(textOf(refused))).toEqual(WRITE_REFUSED)
  const wrongType = await ro.callTool({ name: 'read_rows', arguments: { sheet_id: sheetId, max_chars_per_cell: true } })
  expect(wrongType.isError).toBe(true)
  expect(textOf(wrongType))
    .toBe(`Input validation error: Invalid arguments for tool read_rows: max_chars_per_cell: ${BOUNDS}`)
  for (const c of [rw, rw2, ro]) await c.close()
})

test('MCP 2026-07-28 on the wire: resultType, serverInfo, cache fields, headers and errors', async () => {
  const api = await authedApi()
  const token = await makeAccessToken(api, ['read'], 'e2e mcp modern raw')

  // server/discover needs the token like every request; then versions, capabilities and identity.
  expect((await raw(null, 'server/discover')).status).toBe(401)
  const discover = await raw(token, 'server/discover')
  expect([discover.status, discover.type]).toEqual([200, 'application/json'])
  const { instructions, ...rest } = discover.body.result
  expect(instructions).toMatch(/^Cubex is a spreadsheet workspace\./)
  expect(rest).toEqual({ supportedVersions: [MODERN], capabilities: { tools: { listChanged: false } },
    resultType: 'complete', ttlMs: 300_000, cacheScope: 'private', _meta: STAMP })

  // tools/list: every tool at once (no nextCursor), cacheable for 5 minutes by this token only.
  const tools = await raw(token, 'tools/list')
  expect(Object.keys(tools.body.result).sort()).toEqual(['_meta', 'cacheScope', 'resultType', 'tools', 'ttlMs'])
  expect([tools.body.result.resultType, tools.body.result.ttlMs, tools.body.result.cacheScope, tools.body.result._meta])
    .toEqual(['complete', 300_000, 'private', STAMP])

  // tools/call: resultType and the server's identity; an Mcp-Session-Id is ignored and none is minted.
  const call = await raw(token, 'tools/call', { name: 'list_tables', arguments: {} },
    { ...std('tools/call', 'list_tables'), 'Mcp-Session-Id': 'made-up' })
  expect([call.status, call.body.result.resultType, call.body.result._meta]).toEqual([200, 'complete', STAMP])
  expect(call.headers.get('mcp-session-id')).toBeNull()
  // Mcp-Name may come Base64-encoded; it is decoded before the comparison.
  const encoded = `=?base64?${Buffer.from('list_tables').toString('base64')}?=`
  expect((await raw(token, 'tools/call', { name: 'list_tables', arguments: {} },
    std('tools/call', encoded))).status).toBe(200)

  // Headers missing, or disagreeing with the body: 400 with HeaderMismatch (-32020).
  const mismatch = async (headers: Record<string, string>, method = 'tools/call') => {
    const res = await raw(token, method, method === 'tools/call' ? { name: 'list_tables', arguments: {} } : {}, headers)
    expect([res.status, res.body.error.code, res.body.id]).toEqual([400, -32020, 41])
    return res.body.error.message as string
  }
  expect(await mismatch(std('tools/call', 'read_rows'))).toBe('Bad Request: the request headers and body disagree: '
    + 'the body carries params.name="list_tables" but the Mcp-Name header names "read_rows"')
  expect(await mismatch(std('tools/call'))).toContain('the required Mcp-Name header is absent')
  expect(await mismatch(std('tools/list'))).toContain('the Mcp-Method header names tools/list')
  expect(await mismatch({ 'MCP-Protocol-Version': MODERN }, 'tools/list'))
    .toContain('the required Mcp-Method header is absent')
  expect(await mismatch({ ...std('tools/list'), 'MCP-Protocol-Version': '2025-11-25' }, 'tools/list'))
    .toContain('the MCP-Protocol-Version header names 2025-11-25')

  // A version Cubex doesn't speak: 400 with UnsupportedProtocolVersion (-32022) and every version it does,
  // the ones reached with initialize too, newest first.
  const old = await raw(token, 'tools/list', {}, { ...std('tools/list'), 'MCP-Protocol-Version': '2099-01-01' },
    { ...META, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' })
  expect([old.status, old.body]).toEqual([400, { jsonrpc: '2.0', id: 41, error: { code: -32022,
    message: 'Unsupported protocol version: 2099-01-01', data: { supported: EVERY, requested: '2099-01-01' } } }])
  // The envelope without clientCapabilities, or no _meta under the 2026-07-28 header: malformed, -32602.
  const bare = await raw(token, 'tools/list', {}, undefined, { 'io.modelcontextprotocol/protocolVersion': MODERN })
  const none = await raw(token, 'tools/list', {}, undefined, null)
  expect([bare.status, bare.body.error.code, none.status, none.body.error.code]).toEqual([400, -32602, 400, -32602])
  // tools/list hands out no cursor, so any cursor is invalid: -32602.
  expect((await raw(token, 'tools/list', { cursor: 'abc' })).body).toEqual({ jsonrpc: '2.0', id: 41,
    error: { code: -32602, message: 'Invalid cursor: tools/list answers every tool at once and gives no cursor.' } })

  // Methods Cubex doesn't offer (no resources, and ping is gone in 2026-07-28): 404 with -32601.
  for (const method of ['resources/list', 'prompts/list', 'ping']) {
    const res = await raw(token, method)
    expect([method, res.status, res.body.error]).toEqual([method, 404, { code: -32601, message: 'Method not found' }])
  }

  // subscriptions/listen: Cubex sends no change notices, so the stream acknowledges nothing and ends at once.
  const listen = await raw(token, 'subscriptions/listen', { notifications: { toolsListChanged: true } })
  expect([listen.status, listen.type]).toEqual([200, 'text/event-stream'])
  const frames = listen.text.trim().split('\n\n').map(f => JSON.parse(f.replace(/^event: message\ndata: /, '')))
  expect(frames).toEqual([
    { jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged',
      params: { notifications: {}, _meta: { 'io.modelcontextprotocol/subscriptionId': 41 } } },
    { jsonrpc: '2.0', id: 41,
      result: { resultType: 'complete', _meta: { 'io.modelcontextprotocol/subscriptionId': 41, ...STAMP } } },
  ])

  // No stream to GET and no session to DELETE: Invalid Request (-32600), with no id.
  for (const method of ['GET', 'DELETE']) {
    const res = await fetch(`${BASE}/mcp`, { method, headers: { Authorization: `Bearer ${token}` } })
    expect([method, res.status, await res.json()])
      .toEqual([method, 405, { jsonrpc: '2.0', error: { code: -32600, message: 'Method not allowed' } }])
  }
})

// What a token changes over 2026-07-28 is credited to that token (the change log, and spend caps through the
// same record), as on 2025-11-25 (token-spend.spec.ts, trash-api.spec.ts).
test('MCP 2026-07-28: a write is credited to the token that made it', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2)
  const name = 'e2e mcp modern credit'
  const client = await modernClient(await makeAccessToken(api, ['read', 'write'], name))
  const call = async (tool: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name: tool, arguments: args })
    expect(res.isError, `${tool}: ${textOf(res)}`).toBeFalsy()
    return res.structuredContent as Record<string, any>
  }
  const { rows } = await call('read_rows', { sheet_id: sheetId, limit: 1 })
  await call('delete_rows', { sheet_id: sheetId, row_ids: [rows[0].id] })
  const { changes: [newest] } = await call('get_sheet_history', { sheet_id: sheetId, limit: 1 })
  expect({ action: newest.action, via: newest.via, token_name: newest.token_name, by: newest.by })
    .toEqual({ action: 'rows_deleted', via: 'mcp', token_name: name, by: `the token "${name}" (MCP)` })
  await client.close()
})
