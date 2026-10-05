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
  // transfer_rows AND transform_column are flag-gated at process start
  // (MCP_EFFICIENT_ROWS_ENABLED); mirror the harness env so the suite passes in
  // both flag states. Keep this list sorted — it's compared with toEqual.
  const flagged = ['1', 'true'].includes((process.env.MCP_EFFICIENT_ROWS_ENABLED ?? '').toLowerCase())
  expect(tools).toEqual([
    'add_column', 'append_rows', 'control_run', 'delete_column', 'delete_rows', 'export_csv',
    'get_run_results', 'get_run_status', 'get_sheet', 'import_csv', 'list_models', 'list_runs',
    'list_tables', 'manage_sheet', 'manage_table', 'read_rows', 'rename_column',
    'run_ai_column', 'run_http_enrichment', 'set_default_model', 'sort_sheet',
    ...(flagged ? ['transfer_rows', 'transform_column'] : []),
    'update_cells',
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
  expect(res.status()).toBe(403)
})
