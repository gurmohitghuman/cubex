import { test, expect, APIRequestContext, request as pwRequest } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { authedApi, seedSheet, BASE, makeAccessToken } from './helpers'


// Delegates to helpers.makeAccessToken, which mints straight into the test DB.
async function makeToken(api: APIRequestContext): Promise<string> {
  return makeAccessToken(api, ['read', 'write'], 'efficient rows')
}

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'efficient-rows-e2e', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }))
  return client
}

function parsed(result: any): any {
  const text = result.content?.find((item: any) => item.type === 'text')?.text
  return text ? JSON.parse(text) : null
}

// transfer_rows is flag-gated at process start; without the flag the tool is
// absent from discovery, so the whole workflow test only runs when enabled.
test.skip(
  !['1', 'true'].includes((process.env.MCP_EFFICIENT_ROWS_ENABLED ?? '').toLowerCase()),
  'requires MCP_EFFICIENT_ROWS_ENABLED=1 in the harness env',
)

test('efficient MCP rows: query, batch update, idempotent copy and atomic move', async () => {
  const api = await authedApi()
  const { tableId, sheetId: sourceId } = await seedSheet(api, 4)
  const token = await makeToken(api)
  const v1 = await pwRequest.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  })
  // UI-route creation on purpose: API-created sheets now start truly empty,
  // but this spec covers the PRISTINE-SEED destination path ("Column 1" + 3
  // scaffold rows), which only UI tab creation produces.
  const firstDestination = await api.post(`/api/tables/${tableId}/sheets`, { data: { name: 'Destination' } })
  const secondDestination = await api.post(`/api/tables/${tableId}/sheets`, { data: { name: 'Move Destination' } })
  expect(firstDestination.status()).toBe(201)
  expect(secondDestination.status()).toBe(201)
  const destinationId = (await firstDestination.json()).sheet.id
  const moveDestinationId = (await secondDestination.json()).sheet.id
  const client = await connect(token)
  expect((await client.listTools()).tools.map(t => t.name)).toContain('transfer_rows')

  const exactPage = parsed(await client.callTool({
    name: 'read_rows', arguments: { sheet_id: sourceId, limit: 4 },
  }))
  expect(exactPage.rows).toHaveLength(4)
  expect(exactPage.next_cursor).toBeNull()
  expect(typeof exactPage.row_generation).toBe('number')

  const ids = parsed(await client.callTool({
    name: 'read_rows',
    arguments: {
      sheet_id: sourceId,
      columns: ['val'],
      where: [{ column: 'val', operator: 'contains', value: 'v' }],
      return_mode: 'ids',
      limit: 4,
    },
  }))
  expect(ids.rows).toHaveLength(4)
  expect(ids.rows[0].data).toBeUndefined()
  const count = parsed(await client.callTool({
    name: 'read_rows',
    arguments: { sheet_id: sourceId, where: [{ column: 'val', operator: 'not_empty' }], return_mode: 'count' },
  }))
  expect(count.count).toBe(4)

  const batch = parsed(await client.callTool({
    name: 'update_cells',
    arguments: {
      sheet_id: sourceId,
      updates: ids.rows.slice(0, 2).map((row: any, i: number) => ({ row_id: row.id, data: { val: `edited${i}` } })),
    },
  }))
  expect(batch).toEqual({ updated: 2 })

  const copyArgs = {
    source_sheet_id: sourceId,
    destination_sheet_id: destinationId,
    operation: 'copy',
    selection: { all: true },
    column_mode: 'create_missing',
    column_mapping: { val: 'Value' },
    idempotency_key: crypto.randomUUID(),
  }
  const copied = parsed(await client.callTool({ name: 'transfer_rows', arguments: copyArgs }))
  expect(copied).toMatchObject({ matched: 4, copied: 4, moved: 0, replayed: false })
  const replay = parsed(await client.callTool({ name: 'transfer_rows', arguments: copyArgs }))
  expect(replay).toMatchObject({ matched: 4, copied: 4, replayed: true })
  const keyConflict = await client.callTool({
    name: 'transfer_rows', arguments: { ...copyArgs, operation: 'move' },
  })
  expect(keyConflict.isError).toBe(true)
  const destinationRows = await (await v1.get(`/api/v1/sheets/${destinationId}/rows`)).json()
  expect(destinationRows.rows).toHaveLength(4)
  expect(destinationRows.rows[0].index).toBe(3)
  expect(destinationRows.rows[0].data.Value).toBe('edited0')

  const rollback = await client.callTool({
    name: 'update_cells',
    arguments: {
      sheet_id: sourceId,
      updates: [
        { row_id: ids.rows[0].id, data: { val: 'must-not-stick' } },
        { row_id: crypto.randomUUID(), data: { val: 'bad' } },
      ],
    },
  })
  expect(rollback.isError).toBe(true)
  const afterRollback = parsed(await client.callTool({ name: 'read_rows', arguments: { sheet_id: sourceId } }))
  expect(afterRollback.rows.find((row: any) => row.id === ids.rows[0].id).data.val).toBe('edited0')

  const moved = parsed(await client.callTool({
    name: 'transfer_rows',
    arguments: {
      source_sheet_id: sourceId,
      destination_sheet_id: moveDestinationId,
      operation: 'move',
      selection: { row_ids: [ids.rows[3].id] },
      column_mode: 'create_missing',
      idempotency_key: crypto.randomUUID(),
    },
  }))
  expect(moved).toMatchObject({ matched: 1, copied: 0, moved: 1 })
  expect((await (await v1.get(`/api/v1/sheets/${sourceId}`)).json()).row_count).toBe(3)
  expect((await (await v1.get(`/api/v1/sheets/${moveDestinationId}`)).json()).row_count).toBe(1)

  const webhook = await api.post(`/api/sheets/${destinationId}/webhook`, { data: { name: 'Protected' } })
  expect(webhook.status()).toBe(201)
  const rawColumn = (await webhook.json()).source.rawColumnName
  const spoofAppend = await client.callTool({
    name: 'append_rows', arguments: { sheet_id: destinationId, rows: [{ [rawColumn]: 'fake' }] },
  })
  expect(spoofAppend.isError).toBe(true)
  expect(parsed(spoofAppend).error).toContain('provenance')
  const spoofTransfer = await client.callTool({
    name: 'transfer_rows',
    arguments: {
      source_sheet_id: sourceId,
      destination_sheet_id: destinationId,
      operation: 'copy',
      selection: { row_ids: [ids.rows[0].id] },
      column_mode: 'create_missing',
      column_mapping: { val: rawColumn },
      idempotency_key: crypto.randomUUID(),
    },
  })
  expect(spoofTransfer.isError).toBe(true)

  const filtered = parsed(await client.callTool({
    name: 'read_rows',
    arguments: {
      sheet_id: sourceId, where: [{ column: 'val', operator: 'contains', value: 'edited' }], limit: 1,
    },
  }))
  await v1.post(`/api/v1/sheets/${sourceId}/rows`, { data: { rows: [{ data: { val: 'edited-new' } }] } })
  const stalePage = await client.callTool({
    name: 'read_rows',
    arguments: {
      sheet_id: sourceId,
      where: [{ column: 'val', operator: 'contains', value: 'edited' }],
      cursor: filtered.next_cursor,
      limit: 1,
      expected_data_version: filtered.data_version,
      expected_row_generation: filtered.row_generation,
    },
  })
  expect(stalePage.isError).toBe(true)

  const restCount = await v1.post(`/api/v1/sheets/${sourceId}/rows/query`, {
    data: { where: [{ column: 'val', operator: 'not_empty' }], return_mode: 'count' },
  })
  expect(restCount.status()).toBe(200)
  expect((await restCount.json()).count).toBe(4)
  await client.close()
  await v1.dispose()
})
