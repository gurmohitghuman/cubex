import { test, expect, APIRequestContext, request as pwRequest } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { authedApi, BASE } from './helpers'

// Benchmark: a 10,000-row
// copy and move must complete inside the transfer budgets (2s writer wall time,
// 32 MB stored bytes) against the production build. Success itself proves the
// budget held — the service throws and rolls back past 2s; we log wall times.

const ROWS = 10_000
const COLUMNS = 10
const CELL = 'x'.repeat(80) // ~800B/row of cell data, ~8 MB sheet

test.skip(
  !['1', 'true'].includes((process.env.MCP_EFFICIENT_ROWS_ENABLED ?? '').toLowerCase()),
  'requires MCP_EFFICIENT_ROWS_ENABLED=1 in the harness env',
)

test('bench: 10k-row transfer copy + move stay inside the writer budgets', async () => {
  test.setTimeout(180_000)
  const api = await authedApi()
  const created = await api.post('/api/settings/access-tokens', {
    data: { name: 'bench', scopes: ['read', 'write'] },
  })
  expect(created.status()).toBe(201)
  const token = (await created.json()).token
  const v1 = await pwRequest.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  })
  const table = await v1.post('/api/v1/tables', { data: { name: `Bench ${Date.now()}` } })
  expect(table.status()).toBe(201)
  const tableJson = await table.json()
  const sourceId = tableJson.sheets[0].id
  const dest = await v1.post(`/api/v1/tables/${tableJson.id}/sheets`, { data: { name: 'Bench Dest' } })
  const destId = (await dest.json()).sheet.id

  const names = Array.from({ length: COLUMNS }, (_, i) => `col_${i}`)
  for (const name of names) {
    expect((await v1.post(`/api/v1/sheets/${sourceId}/columns`, { data: { name } })).status()).toBe(201)
  }
  // Adding columns over the API leaves the sheet with no rows, so the 10
  // batches below are the whole 10,000.
  const row = Object.fromEntries(names.map(n => [n, CELL]))
  const sizes = Array(10).fill(1000)
  for (const [batch, size] of sizes.entries()) {
    const res = await v1.post(`/api/v1/sheets/${sourceId}/rows`, {
      data: { rows: Array.from({ length: size }, () => ({ data: row })) },
    })
    if (res.status() !== 201) console.log(`append batch ${batch} -> ${res.status()}: ${(await res.text()).slice(0, 300)}`)
    expect(res.status()).toBe(201)
  }

  const client = new Client({ name: 'bench', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }))
  const parsed = (r: any) => JSON.parse(r.content.find((c: any) => c.type === 'text').text)

  const copyStart = Date.now()
  const copied = parsed(await client.callTool({
    name: 'transfer_rows',
    arguments: {
      source_sheet_id: sourceId,
      destination_sheet_id: destId,
      operation: 'copy',
      selection: { all: true },
      column_mode: 'create_missing',
      idempotency_key: crypto.randomUUID(),
    },
  }))
  const copyMs = Date.now() - copyStart
  expect(copied).toMatchObject({ matched: ROWS, copied: ROWS })

  // Move everything back the other way onto a fresh sheet (exercises purge+delete).
  const dest2 = await v1.post(`/api/v1/tables/${tableJson.id}/sheets`, { data: { name: 'Bench Move' } })
  const dest2Id = (await dest2.json()).sheet.id
  const moveStart = Date.now()
  const moved = parsed(await client.callTool({
    name: 'transfer_rows',
    arguments: {
      source_sheet_id: destId,
      destination_sheet_id: dest2Id,
      operation: 'move',
      selection: { all: true },
      column_mode: 'create_missing',
      idempotency_key: crypto.randomUUID(),
    },
  }))
  const moveMs = Date.now() - moveStart
  expect(moved).toMatchObject({ matched: ROWS, moved: ROWS })

  console.log(`BENCH copy_10k_ms=${copyMs} move_10k_ms=${moveMs} cols=${COLUMNS} cell_bytes=${CELL.length}`)
  await client.close()
  await v1.dispose()

  // Drop the bench's tables so 10k parked rows don't slow every later spec's
  // seeding (they all share the one account).
  const existing = await (await api.get('/api/tables')).json()
  if (Array.isArray(existing)) for (const t of existing) await api.delete(`/api/tables/${t.id}`)
})
