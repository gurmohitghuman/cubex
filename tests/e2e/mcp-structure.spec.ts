import { test, expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { authedApi, BASE, makeAccessToken } from './helpers'

// Step 3b MCP structure tools: the full MCP-only workflow a client is actually
// sold — create a table, add/rename/reorder sheets, import a CSV, read it
// back, replace-import, and tear down — never touching /api/v1 directly.
// Runs as test3 (same bucket isolation rationale as mcp-runs.spec.ts).



async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'e2e-structure-test', version: '1.0.0' })
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

test('MCP structure: table + sheets + CSV import lifecycle, all over MCP', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  // Start from an empty workspace (every spec shares the one account).
  const existing = await (await api.get('/api/tables')).json()
  if (Array.isArray(existing)) for (const t of existing) await api.delete(`/api/tables/${t.id}`)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write'], 'e2e mcp structure'))
  const call = async (name: string, args: any) => parseResult(await client.callTool({ name, arguments: args }))

  // Create a table → arrives with Sheet1.
  const table = await call('manage_table', { action: 'create', name: 'MCP Leads' })
  expect(table.id).toBeTruthy()
  expect(table.sheets[0].name).toBe('Sheet1')
  const sheet1 = table.sheets[0].id

  // Duplicate name → clean error, not a crash.
  const dup = await client.callTool({ name: 'manage_table', arguments: { action: 'create', name: 'MCP Leads' } })
  expect(dup.isError).toBe(true)
  expect(parseResult(dup as any).error).toContain('already exists')

  // Rename the table.
  expect((await call('manage_table', { action: 'rename', table_id: table.id, name: 'MCP Leads 2' })).name)
    .toBe('MCP Leads 2')

  // Sheets: create a second tab, rename it, reorder it first.
  const created = await call('manage_sheet', { action: 'create', table_id: table.id, name: 'Enriched' })
  const sheet2 = created.sheet.id
  expect(created.sheets).toHaveLength(2)
  expect((await call('manage_sheet', { action: 'rename', table_id: table.id, sheet_id: sheet2, name: 'Results' }))
    .sheets.map((s: any) => s.name)).toContain('Results')
  const reordered = await call('manage_sheet', {
    action: 'reorder', table_id: table.id, ordered_sheet_ids: [sheet2, sheet1],
  })
  expect(reordered.sheets[0].id).toBe(sheet2)

  // CSV import into Sheet1: header creates columns, rows append.
  const imported = await call('import_csv', {
    sheet_id: sheet1, csv: 'Company,Domain\nAcme,acme.com\nGlobex,globex.com\n',
  })
  expect(imported.rows_imported).toBe(2)
  expect(imported.new_columns).toEqual(expect.arrayContaining(['Company', 'Domain']))
  const rows = await call('read_rows', { sheet_id: sheet1 })
  expect(rows.rows.map((r: any) => r.data.Company)).toEqual(['Acme', 'Globex'])

  // Replace mode wipes and reloads.
  const replaced = await call('import_csv', {
    sheet_id: sheet1, csv: 'Company,Domain\nInitech,initech.com\n', mode: 'replace',
  })
  expect(replaced).toMatchObject({ rows_imported: 1, replaced: true })
  const after = await call('read_rows', { sheet_id: sheet1 })
  expect(after.rows).toHaveLength(1)
  expect(after.rows[0].data.Company).toBe('Initech')

  // Malformed CSV (colliding headers) → actionable error.
  const badCsv = await client.callTool({
    name: 'import_csv', arguments: { sheet_id: sheet1, csv: 'Name,Name \nx,y\n' },
  })
  expect(badCsv.isError).toBe(true)

  // Delete a sheet; deleting the LAST sheet is refused; delete the table.
  expect((await call('manage_sheet', { action: 'delete', table_id: table.id, sheet_id: sheet2 })).deleted).toBe(true)
  const lastSheet = await client.callTool({
    name: 'manage_sheet', arguments: { action: 'delete', table_id: table.id, sheet_id: sheet1 },
  })
  expect(lastSheet.isError).toBe(true)
  expect(parseResult(lastSheet as any).error).toContain('at least one sheet')
  expect((await call('manage_table', { action: 'delete', table_id: table.id })).deleted).toBe(true)
  expect((await call('list_tables', {})).tables.find((t: any) => t.id === table.id)).toBeUndefined()

  await client.close()
})

test('MCP structure: read-only scope is denied for every structure mutation', async () => {
  const api = await authedApi()
  const ro = await mcpClient(await makeAccessToken(api, ['read'], 'e2e mcp structure ro'))
  for (const [name, args] of [
    ['manage_table', { action: 'create', name: 'X' }],
    ['manage_sheet', { action: 'create', table_id: 'x' }],
    ['import_csv', { sheet_id: 'x', csv: 'A\n1\n' }],
  ] as const) {
    const denied = await ro.callTool({ name, arguments: args as any })
    expect(denied.isError).toBe(true)
    expect(parseResult(denied as any).error).toContain("'write' scope")
  }
  await ro.close()
})
