import { test, expect, APIRequestContext, request as pwRequest } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { authedApi, seedSheet, BASE, makeAccessToken } from './helpers'

// Owner brief 2026-07-17: numeric where operators, transfer_rows columns
// subset + created_columns/dest_row_count + create_missing default, truly
// empty API-created sheets, and header-only CSV creating its columns.


test.skip(
  !['1', 'true'].includes((process.env.MCP_EFFICIENT_ROWS_ENABLED ?? '').toLowerCase()),
  'requires MCP_EFFICIENT_ROWS_ENABLED=1 in the harness env',
)

// Delegates to helpers.makeAccessToken, which mints straight into the test DB.
async function makeToken(api: APIRequestContext): Promise<string> {
  return makeAccessToken(api, ['read', 'write'], 'brief features')
}

function parsed(result: any): any {
  const text = result.content?.find((item: any) => item.type === 'text')?.text
  return text ? JSON.parse(text) : null
}

test('brief: numeric filters, transfer subset/created_columns, empty sheets, header-only CSV', async () => {
  const api = await authedApi()
  const { tableId, sheetId: sourceId } = await seedSheet(api, 0)
  const token = await makeToken(api)
  const client = new Client({ name: 'brief-e2e', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }))

  // Numeric filter semantics: only parseable cells match; '' and 'N/A' never do.
  for (const name of ['company', 'score']) {
    parsed(await client.callTool({ name: 'add_column', arguments: { sheet_id: sourceId, name } }))
  }
  const appended = parsed(await client.callTool({
    name: 'append_rows',
    arguments: {
      sheet_id: sourceId,
      rows: [
        { company: 'a', score: '3' },
        { company: 'b', score: '7.5' },
        { company: 'c', score: 'N/A' },
        { company: 'd', score: '' },
      ],
    },
  }))
  expect(appended.rows).toHaveLength(4)
  const hits = parsed(await client.callTool({
    name: 'read_rows',
    arguments: { sheet_id: sourceId, where: [{ column: 'score', operator: 'gte', value: '7' }] },
  }))
  expect(hits.rows.map((r: any) => r.data.company)).toEqual(['b'])
  const badValue = await client.callTool({
    name: 'read_rows',
    arguments: { sheet_id: sourceId, where: [{ column: 'score', operator: 'gte', value: 'high' }] },
  })
  expect(badValue.isError).toBe(true)

  // API-created sheets start truly empty (no "Column 1", no scaffold rows).
  const createdSheet = parsed(await client.callTool({
    name: 'manage_sheet', arguments: { action: 'create', table_id: tableId, name: 'Agent Dest' },
  }))
  const destId = createdSheet.sheet.id
  const destMeta = parsed(await client.callTool({ name: 'get_sheet', arguments: { sheet_id: destId } }))
  expect(destMeta.columns).toEqual([])
  expect(destMeta.row_count).toBe(0)

  // Filtered transfer with a columns subset into the empty destination:
  // create_missing is now the default; created_columns + dest_row_count return.
  const transferred = parsed(await client.callTool({
    name: 'transfer_rows',
    arguments: {
      source_sheet_id: sourceId,
      destination_sheet_id: destId,
      operation: 'copy',
      selection: { where: [{ column: 'score', operator: 'gte', value: '3' }] },
      columns: ['company'],
      idempotency_key: crypto.randomUUID(),
    },
  }))
  expect(transferred).toMatchObject({
    matched: 2, copied: 2, created_columns: ['company'], dest_row_count: 2, replayed: false,
  })
  const destRows = parsed(await client.callTool({ name: 'read_rows', arguments: { sheet_id: destId } }))
  expect(destRows.rows.map((r: any) => r.data)).toEqual([{ company: 'a' }, { company: 'b' }])

  // Header-only CSV creates the header's columns on a fresh empty sheet.
  const csvSheet = parsed(await client.callTool({
    name: 'manage_sheet', arguments: { action: 'create', table_id: tableId, name: 'CSV Schema' },
  }))
  const imported = parsed(await client.callTool({
    name: 'import_csv',
    arguments: { sheet_id: csvSheet.sheet.id, csv: 'Name,Email,Fit Score\n', mode: 'append' },
  }))
  expect(imported.rows_imported).toBe(0)
  const csvMeta = parsed(await client.callTool({ name: 'get_sheet', arguments: { sheet_id: csvSheet.sheet.id } }))
  expect(csvMeta.columns).toEqual(['Name', 'Email', 'Fit Score'])

  await client.close()
})
