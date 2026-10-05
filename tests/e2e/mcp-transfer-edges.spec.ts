import { test, expect, APIRequestContext, request as pwRequest } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { authedApi, seedSheet, BASE, makeAccessToken } from './helpers'

// Regression edges from the transfer review: (1) a webhook provenance marker on
// a destination with no rows must survive a transfer's column_order rewrite;
// (2) prototype-named columns
// ("constructor", "toString") on sparse rows must not leak inherited members
// into filters or projections.


test.skip(
  !['1', 'true'].includes((process.env.MCP_EFFICIENT_ROWS_ENABLED ?? '').toLowerCase()),
  'requires MCP_EFFICIENT_ROWS_ENABLED=1 in the harness env',
)

// Delegates to helpers.makeAccessToken, which mints straight into the test DB.
async function makeToken(api: APIRequestContext): Promise<string> {
  return makeAccessToken(api, ['read', 'write'], 'transfer edges')
}

function parsed(result: any): any {
  const text = result.content?.find((item: any) => item.type === 'text')?.text
  return text ? JSON.parse(text) : null
}

test('transfer edges: ghost webhook marker survives; prototype column names are safe', async () => {
  const api = await authedApi()
  const { tableId, sheetId: sourceId } = await seedSheet(api, 2) // 'val' = v0..v1
  const token = await makeToken(api)
  const client = new Client({ name: 'transfer-edges-e2e', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }))
  const v1 = await pwRequest.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  })

  // (1) Destination owns a webhook and has no rows: creating the webhook only
  // lists its marker column. A transfer into it must keep the marker when it
  // rewrites column_order.
  const created = await v1.post(`/api/v1/tables/${tableId}/sheets`, { data: { name: 'Edge Dest' } })
  expect(created.status()).toBe(201)
  const destinationId = (await created.json()).sheet.id
  const webhook = await api.post(`/api/sheets/${destinationId}/webhook`, { data: { name: 'Edge' } })
  expect(webhook.status()).toBe(201)
  const marker = (await webhook.json()).source.rawColumnName
  const destRows = parsed(await client.callTool({ name: 'read_rows', arguments: { sheet_id: destinationId } }))
  expect(destRows.rows).toHaveLength(0)
  const transferred = parsed(await client.callTool({
    name: 'transfer_rows',
    arguments: {
      source_sheet_id: sourceId,
      destination_sheet_id: destinationId,
      operation: 'copy',
      selection: { all: true },
      column_mode: 'create_missing',
      idempotency_key: crypto.randomUUID(),
    },
  }))
  expect(transferred).toMatchObject({ matched: 2, copied: 2 })
  const destMeta = parsed(await client.callTool({ name: 'get_sheet', arguments: { sheet_id: destinationId } }))
  expect(destMeta.columns).toContain(marker)
  expect(destMeta.columns).toContain('val')

  // (2) A real column named "constructor": add_column backfills existing rows
  // with an own '' key, so a row appended WITHOUT the key is the sparse case —
  // filters and projections must read own properties only, never the inherited
  // Object.prototype member.
  const added = parsed(await client.callTool({
    name: 'add_column', arguments: { sheet_id: sourceId, name: 'constructor' },
  }))
  expect(added).toBeTruthy()
  const sourceRows = parsed(await client.callTool({ name: 'read_rows', arguments: { sheet_id: sourceId } }))
  await client.callTool({
    name: 'update_cells',
    arguments: { row_id: sourceRows.rows[0].id, data: { constructor: 'present' } },
  })
  const appended = parsed(await client.callTool({
    name: 'append_rows', arguments: { sheet_id: sourceId, rows: [{ val: 'sparse' }] },
  }))
  const sparseId = appended.rows[0].id
  const filled = parsed(await client.callTool({
    name: 'read_rows',
    arguments: { sheet_id: sourceId, where: [{ column: 'constructor', operator: 'not_empty' }] },
  }))
  expect(filled.rows).toHaveLength(1)
  expect(filled.rows[0].id).toBe(sourceRows.rows[0].id)
  const projectedSparse = parsed(await client.callTool({
    name: 'read_rows', arguments: { sheet_id: sourceId, columns: ['constructor'] },
  }))
  const sparse = projectedSparse.rows.find((row: any) => row.id === sparseId)
  expect(sparse.data).toEqual({ constructor: '' })

  await client.close()
  await v1.dispose()
})
