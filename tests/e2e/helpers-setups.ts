import { expect, type APIRequestContext } from '@playwright/test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { seedSheet, getSheet } from './helpers'
import { call } from './helpers-mcp'

// Shared by the setups specs: a sheet holding some rows (a new one in an
// existing table, or a fresh table), waiting for a setup run to end, and a
// column's values.

export const POSTS = 'https://jsonplaceholder.typicode.com/posts/1?d={{Domain}}'

export async function sheetWith(api: APIRequestContext, tableId: string | null, data: Record<string, string>[]) {
  let sheetId: string
  if (!tableId) {
    const seeded = await seedSheet(api, data.length)
    sheetId = seeded.sheetId
    tableId = seeded.tableId
  } else {
    // A new sheet starts with 3 blank rows.
    const res = await api.post(`/api/tables/${tableId}/sheets`, { data: { name: `S${Date.now() % 100000}` } })
    sheetId = (await res.json()).sheet.id
    if (data.length > 3) await api.post(`/api/sheets/${sheetId}/rows`, { data: { count: data.length - 3 } })
  }
  for (const c of Object.keys(data[0])) await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: c } })
  const updates = data.flatMap((r, i) =>
    Object.entries(r).map(([columnName, value]) => ({ rowIndex: i, columnName, value })))
  expect((await api.put(`/api/sheets/${sheetId}/data`, { data: { updates } })).ok()).toBeTruthy()
  return { tableId: tableId!, sheetId }
}

export async function waitSetup(client: Client, id: string) {
  let last: any
  await expect.poll(async () => (last = await call(client, 'get_setup_run', { setup_run_id: id })).status,
    { timeout: 60_000 }).toMatch(/done|failed|cancelled/)
  return last
}

export const column = async (api: APIRequestContext, sheetId: string, name: string) =>
  (await getSheet(api, sheetId)).data.rows.map((r: any) => r.data[name] ?? '')

