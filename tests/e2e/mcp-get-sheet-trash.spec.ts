import { test, expect } from '@playwright/test'
import { BASE, authedApi, makeAccessToken } from './helpers'
import { mcpClient, call, callError } from './helpers-mcp'

// get_sheet on a sheet in the trash answers as other tools do: not found, with the restore_from_trash hint and its
// trash id; REST GET /api/v1/sheets/:id answers 404; restored, both describe it again.
test('get_sheet on a sheet in the trash: not found, with the restore hint', async () => {
  const api = await authedApi()
  const token = await makeAccessToken(api, ['read', 'write'], `get-sheet-trash-${Date.now()}`)
  const client = await mcpClient(token)
  const table = await call(client, 'manage_table', { action: 'create', name: `Trash me ${Date.now()}` })
  const extra = await call(client, 'manage_sheet', { action: 'create', table_id: table.id, name: 'Gone soon' })
  const sheetId = extra.id ?? extra.sheet?.id
  expect((await call(client, 'get_sheet', { sheet_id: sheetId })).name).toBe('Gone soon')

  const deleted = await call(client, 'manage_sheet', { action: 'delete', table_id: table.id, sheet_id: sheetId })
  expect(deleted.deleted).toBe(true)
  const said = await callError(client, 'get_sheet', { sheet_id: sheetId })
  expect(said).toContain('in the trash')
  expect(said).toContain('restore_from_trash')
  const auth = { Authorization: `Bearer ${token}` }
  expect((await api.get(`${BASE}/api/v1/sheets/${sheetId}`, { headers: auth })).status()).toBe(404)

  const trashId = Number(/trash_ids \[(\d+)/.exec(said)![1])
  await call(client, 'restore_from_trash', { trash_ids: [trashId] })
  await expect.poll(async () => (await call(client, 'get_sheet', { sheet_id: sheetId }).catch(() => null))?.name,
    { timeout: 15_000 }).toBe('Gone soon')
  expect((await api.get(`${BASE}/api/v1/sheets/${sheetId}`, { headers: auth })).status()).toBe(200)
})
