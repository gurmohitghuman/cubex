import { test, expect, APIRequestContext } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { authedApi, seedSheet, BASE, makeAccessToken } from './helpers'

// Step 3a: the MCP server at /mcp, driven by the SDK's own client over
// Streamable HTTP — the same path Claude Code/Desktop take. Covers: tool
// discovery, read/write round-trip via stable row ids, scope enforcement,
// bad-token rejection, and the spec-mandated Origin guard.


// Delegates to helpers.makeAccessToken, which mints straight into the test DB.
async function makeToken(api: APIRequestContext, scopes: string[], name: string): Promise<string> {
  return makeAccessToken(api, scopes, name)
}

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'e2e-test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  return client
}

function parseResult(res: { content?: Array<{ type: string; text?: string }> }): any {
  const text = res.content?.find(c => c.type === 'text')?.text
  return text ? JSON.parse(text) : null
}

test('MCP: discover tools, read and write a sheet end-to-end', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 3) // 'val' = v0..v2
  const client = await mcpClient(await makeToken(api, ['read', 'write'], 'e2e mcp rw'))

  // Tool discovery: the data-plane + enrichment + structure + model toolset.
  const tools = (await client.listTools()).tools.map(t => t.name).sort()
  // Keep this list sorted — it's compared with toEqual.
  expect(tools).toEqual([
    'add_column', 'add_enrichment_field', 'add_list_rows', 'ai_visibility', 'append_rows', 'apply_setup',
    'check_run_condition',
    'clean_column', 'control_run', 'control_setup_run',
    'create_download_link', 'create_upload_link', 'delete_column', 'delete_rows', 'delete_setup', 'export_csv',
    'formula_column',
    'get_balances', 'get_enrichment', 'get_list_fields', 'get_run_results', 'get_run_status', 'get_setup_run',
    'get_sheet', 'get_sheet_history', 'get_usage', 'import_csv',
    'list_models', 'list_run_webhooks', 'list_runs', 'list_saved_keys', 'list_setup_versions',
    'list_setups', 'list_tables', 'list_trash', 'lookup_column',
    'manage_run_webhook', 'manage_setup_version', 'manage_sheet', 'manage_table', 'manage_view',
    'read_rows',
    'remove_duplicates',
    'rename_column', 'restore_from_trash', 'restore_setup_version',
    'run_ai_column', 'run_enrichment', 'run_http_enrichment', 'save_setup', 'search_enrichments', 'set_auto_dedupe',
    'set_auto_run',
    'set_column_order', 'set_default_model', 'set_description', 'sort_sheet',
    'transfer_rows', 'transform_column',
    'undo_run', 'update_cells', 'waterfall_column', 'write_formula', 'write_run_condition',
  ])

  // Discovery → read: resolve the seeded sheet, read its rows.
  const tablesRes = parseResult(await client.callTool({ name: 'list_tables', arguments: {} }))
  const sheet = tablesRes.tables.flatMap((t: any) => t.sheets).find((s: any) => s.id === sheetId)
  expect(sheet.row_count).toBe(3)

  const page = parseResult(await client.callTool({
    name: 'read_rows', arguments: { sheet_id: sheetId, limit: 2 },
  }))
  expect(page.rows).toHaveLength(2)
  expect(page.rows[0].data.val).toBe('v0')
  expect(page.next_cursor).toBe(page.rows[1].index)

  // Write path: add a column, append a row, update it by stable id.
  expect(parseResult(await client.callTool({
    name: 'add_column', arguments: { sheet_id: sheetId, name: 'Status' },
  })).name).toBe('Status')
  const appended = parseResult(await client.callTool({
    name: 'append_rows', arguments: { sheet_id: sheetId, rows: [{ val: 'v3', Status: 'new' }] },
  }))
  expect(appended.rows).toHaveLength(1)
  const updated = parseResult(await client.callTool({
    name: 'update_cells', arguments: { row_id: appended.rows[0].id, data: { Status: 'done' } },
  }))
  expect(updated.data).toMatchObject({ val: 'v3', Status: 'done' })

  // Unknown column → isError with actionable message.
  const bad = await client.callTool({ name: 'append_rows', arguments: { sheet_id: sheetId, rows: [{ nope: 'x' }] } })
  expect(bad.isError).toBe(true)
  expect(parseResult(bad as any).error).toContain('Unknown column')

  // Sort permanently reorders; row ids survive.
  const sorted = parseResult(await client.callTool({
    name: 'sort_sheet', arguments: { sheet_id: sheetId, column: 'val', direction: 'desc' },
  }))
  expect(sorted.rows_reordered).toBe(4)
  const after = parseResult(await client.callTool({ name: 'read_rows', arguments: { sheet_id: sheetId } }))
  expect(after.rows[0].data.val).toBe('v3')
  expect(after.rows.map((r: any) => r.id)).toContain(appended.rows[0].id)

  // Cleanup: delete the appended row + column.
  expect(parseResult(await client.callTool({
    name: 'delete_rows', arguments: { sheet_id: sheetId, row_ids: [appended.rows[0].id] },
  })).deleted).toBe(1)
  expect(parseResult(await client.callTool({
    name: 'delete_column', arguments: { sheet_id: sheetId, column: 'Status' },
  })).deleted).toBe(true)

  await client.close()
})

test('MCP authz: read-only scope blocks writes; bad token cannot connect', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 1)

  const ro = await mcpClient(await makeToken(api, ['read'], 'e2e mcp ro'))
  const read = parseResult(await ro.callTool({ name: 'get_sheet', arguments: { sheet_id: sheetId } }))
  expect(read.columns).toEqual(['val'])
  const denied = await ro.callTool({ name: 'append_rows', arguments: { sheet_id: sheetId, rows: [{ val: 'x' }] } })
  expect(denied.isError).toBe(true)
  expect(parseResult(denied as any).error).toContain("'write' scope")
  await ro.close()

  // Invalid token: the initialize POST 401s → connect rejects.
  const badClient = new Client({ name: 'e2e-bad', version: '1.0.0' })
  const badTransport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: 'Bearer cubex_pat_' + '0'.repeat(64) } },
  })
  await expect(badClient.connect(badTransport)).rejects.toThrow()
})

test('MCP origin guard: a foreign browser Origin is rejected pre-auth', async () => {
  const api = await authedApi()
  const token = await makeToken(api, ['read'], 'e2e mcp origin')
  // Raw POST with a hostile Origin — 403 even with a VALID token, because the
  // guard runs before auth (DNS-rebinding defense; MCP spec mandate).
  const res = await api.post(`${BASE}/mcp`, {
    headers: {
      Origin: 'https://evil.example',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    data: { jsonrpc: '2.0', method: 'ping', id: 1 },
  })
  // A JSON-RPC error with no id, as the transport allows; the spec names no code
  // for it, so Cubex's own, from outside the JSON-RPC reserved range.
  expect([res.status(), await res.json()])
    .toEqual([403, { jsonrpc: '2.0', error: { code: -31403, message: 'Forbidden origin' } }])
})

// Clients on 2025-11-25, like this v1 client, open with initialize: Cubex
// answers them as before, statelessly, one JSON body a request. The 2026-07-28
// revision is mcp-protocol.spec.ts, on the v2 client.
test('MCP 2025-11-25: the initialize handshake, and plain JSON answers with no session', async () => {
  const api = await authedApi()
  const token = await makeToken(api, ['read'], 'e2e mcp legacy')
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  const client = new Client({ name: 'e2e-legacy', version: '1.0.0' })
  await client.connect(transport)
  expect([transport.protocolVersion, transport.sessionId]).toEqual(['2025-11-25', undefined])
  expect(client.getServerVersion()).toEqual({ name: 'cubex', version: '1.0.0' })
  expect(client.getServerCapabilities()).toEqual({ tools: { listChanged: false } })
  expect(client.getInstructions()).toMatch(/^Cubex is a spreadsheet workspace\./)
  await client.close()

  // The same as raw POSTs: no session id, and none of 2026-07-28's fields.
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${BASE}/mcp`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', ...headers },
  })
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e-raw', version: '1' } } })
  expect([init.status, init.headers.get('content-type'), init.headers.get('mcp-session-id')])
    .toEqual([200, 'application/json', null])
  const { result } = await init.json()
  expect(Object.keys(result).sort()).toEqual(['capabilities', 'instructions', 'protocolVersion', 'serverInfo'])
  expect(result.protocolVersion).toBe('2025-11-25')
  const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'MCP-Protocol-Version': '2025-11-25' })
  expect([list.status, list.headers.get('content-type')]).toEqual([200, 'application/json'])
  expect(Object.keys((await list.json()).result)).toEqual(['tools'])

  // tools/list hands out no cursor, so a cursor is refused with -32602 here too.
  const cursor = await post({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { cursor: 'abc' } })
  expect(await cursor.json()).toEqual({ jsonrpc: '2.0', id: 3,
    error: { code: -32602, message: 'Invalid cursor: tools/list answers every tool at once and gives no cursor.' } })
  // A batch (which 2025-03-26 clients may send) gets one JSON array, an answer for each request in order.
  const batch = await post([{ jsonrpc: '2.0', id: 4, method: 'tools/list' },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} } }])
  const [listed, unknown] = await batch.json()
  expect([batch.status, listed.id, Object.keys(listed.result), unknown]).toEqual([200, 4, ['tools'],
    { jsonrpc: '2.0', id: 5, error: { code: -32602, message: 'Tool nope not found' } }])
})
