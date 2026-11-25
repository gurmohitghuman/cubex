import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { authedApi, seedSheet, BASE, makeAccessToken } from './helpers'
import { mcpClient, call, callError } from './helpers-mcp'

// A sheet's incoming webhook over /api/v1/sheets/:id/webhook and manage_sheet_webhook
// (services/sheet-webhook.ts, the service the app's Webhook drawer uses too): a read key sees the state but
// never the URL; a write key creates it and sees the URL until the first event; turn off and on, rotate (the
// old URL stops at once), fields fill their columns on each event and go without their column, delete, a
// sheet in the trash is not found, and webhook: true on a table or sheet create. Events go to the real
// public endpoint.

let api: APIRequestContext
let sender: APIRequestContext
let reader: APIRequestContext
let writer: APIRequestContext
let readMcp: Client
let writeMcp: Client

const bearer = (token: string) =>
  pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${token}` } })
// The URL is absolute, at the address the caller reached Cubex on (no PUBLIC_URL in e2e): a sender posts to it.
const send = (url: string, body: unknown) => {
  expect(url.startsWith(`${BASE}/api/webhooks/`), url).toBe(true)
  return sender.post(url, { data: body })
}

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  api = await authedApi()
  sender = await pwRequest.newContext({ baseURL: BASE })
  reader = await bearer(await makeAccessToken(api, ['read'], 'e2e sheet webhook read'))
  writer = await bearer(await makeAccessToken(api, ['read', 'write'], 'e2e sheet webhook write'))
  readMcp = await mcpClient(await makeAccessToken(api, ['read'], 'e2e sheet webhook mcp read'))
  writeMcp = await mcpClient(await makeAccessToken(api, ['read', 'write'], 'e2e sheet webhook mcp write'))
})
test.afterAll(async () => {
  await Promise.all([readMcp?.close(), writeMcp?.close(), sender?.dispose(), reader?.dispose(), writer?.dispose()])
})

test('REST: create, the URL only for write and until the first event, fields, off and on, rotate, delete', async () => {
  const { sheetId } = await seedSheet(api, 2)
  const at = `/api/v1/sheets/${sheetId}/webhook`

  expect(await (await reader.get(at)).json()).toEqual({ webhook: null })
  expect((await reader.post(at)).status()).toBe(403)
  const made = await writer.post(at)
  expect(made.status()).toBe(201)
  const hook = (await made.json()).webhook
  expect(hook).toMatchObject({ sheet_id: sheetId, enabled: true, url_hidden: false, column: 'Webhook',
    events_received: 0, fields: [] })
  expect(hook.url).toMatch(new RegExp(`^${BASE}/api/webhooks/[A-Za-z0-9_-]+$`))
  expect((await writer.post(at)).status()).toBe(409)

  // A read key sees the state, never the URL; a write key sees it until the first event.
  expect((await (await reader.get(at)).json()).webhook).toMatchObject({ url: null, url_hidden: false })
  expect((await (await writer.get(at)).json()).webhook.url).toBe(hook.url)

  // A field fills its new column from each event.
  expect((await writer.post(`${at}/fields`, { data: { json_path: '$.email', column: 'Email', as: 'xml' } })).status())
    .toBe(400)
  expect((await writer.post(`${at}/fields`, { data: { json_path: '$..email', column: 'Email' } })).status()).toBe(400)
  expect((await reader.post(`${at}/fields`, { data: { json_path: '$.email', column: 'Email' } })).status()).toBe(403)
  const added = await writer.post(`${at}/fields`, { data: { json_path: '$.email', column: 'Email' } })
  expect(added.status()).toBe(201)
  const field = (await added.json()).webhook.fields[0]
  expect(field).toMatchObject({ json_path: '$.email', column: 'Email', as: 'text' })

  expect((await send(hook.url, { email: 'ana@example.com' })).status()).toBe(202)
  const after = (await (await writer.get(at)).json()).webhook
  expect(after).toMatchObject({ url: null, url_hidden: true, events_received: 1 })
  const rows = (await (await reader.get(`/api/v1/sheets/${sheetId}/rows`)).json()).rows as
    Array<{ data: Record<string, unknown> }>
  expect(rows.map(r => r.data.Email ?? null)).toEqual([null, null, 'ana@example.com'])

  // Off: events get 404 and add nothing. On again: they add rows.
  expect((await writer.patch(at, { data: { enabled: 'no' } })).status()).toBe(400)
  expect(await (await writer.patch(at, { data: { enabled: false } })).json()).toMatchObject({
    webhook: { enabled: false } })
  expect((await send(hook.url, { email: 'off@example.com' })).status()).toBe(404)
  await writer.patch(at, { data: { enabled: true } })
  expect((await send(hook.url, { email: 'on@example.com' })).status()).toBe(202)

  // Rotate: a new URL in the answer, the old one stops at once.
  const rotated = (await (await writer.post(`${at}/rotate`)).json()).webhook
  expect(rotated.url).toMatch(/\/api\/webhooks\//)
  expect(rotated.url).not.toBe(hook.url)
  expect((await send(hook.url, { email: 'old@example.com' })).status()).toBe(404)
  expect((await send(rotated.url, { email: 'new@example.com' })).status()).toBe(202)

  // Removing a field keeps its column and values.
  expect((await (await writer.delete(`${at}/fields/${field.id}`)).json()).webhook.fields).toEqual([])
  expect((await writer.delete(`${at}/fields/${field.id}`)).status()).toBe(404)
  const sheet = (await (await reader.get(`/api/v1/sheets/${sheetId}`)).json()) as { columns: string[] }
  expect(sheet.columns).toEqual(expect.arrayContaining(['Webhook', 'Email']))

  expect((await reader.delete(at)).status()).toBe(403)
  expect(await (await writer.delete(at)).json()).toEqual({ deleted: true })
  expect(await (await writer.get(at)).json()).toEqual({ webhook: null })
  expect((await writer.post(`${at}/rotate`)).status()).toBe(404)
  expect((await send(rotated.url, { email: 'gone@example.com' })).status()).toBe(404)
})

test('REST: webhook true on a table or sheet create; a sheet in the trash is not found', async () => {
  const name = `Webhook table ${Date.now()}`
  expect((await writer.post('/api/v1/tables', { data: { name, webhook: 'yes' } })).status()).toBe(400)
  const table = await (await writer.post('/api/v1/tables', { data: { name, webhook: true } })).json()
  expect(table.webhook).toMatchObject({ sheet_id: table.sheets[0].id, enabled: true, column: 'Webhook' })
  expect((await send(table.webhook.url, { a: 1 })).status()).toBe(202)

  const plain = await (await writer.post(`/api/v1/tables/${table.id}/sheets`, { data: { name: 'Plain' } })).json()
  expect(plain.webhook).toBeUndefined()
  const tab = await (await writer.post(`/api/v1/tables/${table.id}/sheets`,
    { data: { name: 'Events', webhook: true } })).json()
  expect(tab.sheet.name).toBe('Events')
  expect(tab.webhook).toMatchObject({ sheet_id: tab.sheet.id, url_hidden: false })

  expect((await writer.delete(`/api/v1/tables/${table.id}/sheets/${tab.sheet.id}`)).ok()).toBeTruthy()
  expect((await writer.get(`/api/v1/sheets/${tab.sheet.id}/webhook`)).status()).toBe(404)
  expect((await send(tab.webhook.url, { a: 1 })).status()).toBe(404)
  await writer.delete(`/api/v1/tables/${table.id}`)
})

test('MCP manage_sheet_webhook: each action, the URL only for write, and what it refuses', async () => {
  const { sheetId } = await seedSheet(api, 1)
  const hook = (args: Record<string, unknown>) => call(writeMcp, 'manage_sheet_webhook', { sheet_id: sheetId, ...args })
  const refused = (args: Record<string, unknown>, who = writeMcp) =>
    callError(who, 'manage_sheet_webhook', { sheet_id: sheetId, ...args })

  expect((await call(readMcp, 'manage_sheet_webhook', { sheet_id: sheetId, action: 'get' })).webhook).toBeNull()
  expect(await refused({ action: 'create' }, readMcp)).toMatch(/'write' scope/)
  const made = await hook({ action: 'create' })
  expect(made.webhook).toMatchObject({ enabled: true, url_hidden: false, column: 'Webhook' })
  expect(made.changed[0]).toMatchObject({ sheet_id: sheetId, columns: ['Webhook'] })
  expect(await refused({ action: 'create' })).toMatch(/already has a webhook/)
  expect((await call(readMcp, 'manage_sheet_webhook', { sheet_id: sheetId, action: 'get' })).webhook.url).toBeNull()

  expect(await refused({ action: 'add_field', json_path: '$.email' })).toMatch(/needs json_path and column/)
  expect(await refused({ action: 'turn_off', column: 'Email' })).toMatch(/for add_field/)
  expect(await refused({ action: 'get', field_id: 'x' })).toMatch(/for remove_field/)
  const added = await hook({ action: 'add_field', json_path: '$.plan', column: 'Plan', as: 'json' })
  expect(added.webhook.fields).toEqual([expect.objectContaining({ json_path: '$.plan', column: 'Plan', as: 'json' })])
  expect(added.changed[0].columns).toEqual(['Plan'])

  expect((await hook({ action: 'turn_off' })).webhook.enabled).toBe(false)
  expect((await send(made.webhook.url, { plan: { name: 'pro' } })).status()).toBe(404)
  expect((await hook({ action: 'turn_on' })).webhook.enabled).toBe(true)
  expect((await send(made.webhook.url, { plan: { name: 'pro' } })).status()).toBe(202)
  expect((await hook({ action: 'get' })).webhook).toMatchObject({ url: null, url_hidden: true, events_received: 1 })

  const rotated = (await hook({ action: 'rotate' })).webhook
  expect(rotated.url).not.toBe(made.webhook.url)
  expect((await send(made.webhook.url, {})).status()).toBe(404)

  const fieldId = added.webhook.fields[0].id
  expect((await hook({ action: 'remove_field', field_id: fieldId })).webhook.fields).toEqual([])
  expect(await refused({ action: 'remove_field', field_id: fieldId })).toMatch(/Field not found/)
  expect(await refused({ action: 'delete' }, readMcp)).toMatch(/'write' scope/)
  expect(await hook({ action: 'delete' })).toMatchObject({ deleted: true })
  expect(await refused({ action: 'rotate' })).toMatch(/No webhook on this sheet/)
  expect(await refused({ action: 'get', sheet_id: 'no-such-sheet' })).toMatch(/Sheet not found/)
})

test('MCP manage_table and manage_sheet create with webhook true', async () => {
  const table = await call(writeMcp, 'manage_table',
    { action: 'create', name: `MCP hooks ${Date.now()}`, webhook: true })
  expect(table.webhook).toMatchObject({ sheet_id: table.sheets[0].id, column: 'Webhook' })
  expect(table.changed[0].columns).toEqual(['Webhook'])
  expect((await send(table.webhook.url, { a: 1 })).status()).toBe(202)
  expect(await callError(writeMcp, 'manage_table', { action: 'rename', table_id: table.id, name: 'x', webhook: true }))
    .toMatch(/webhook is for create/)

  const tab = await call(writeMcp, 'manage_sheet', { action: 'create', table_id: table.id, webhook: true })
  expect(tab.webhook).toMatchObject({ sheet_id: tab.sheet.id, url_hidden: false })
  const plain = await call(writeMcp, 'manage_sheet', { action: 'create', table_id: table.id })
  expect(plain.webhook).toBeUndefined()
  await call(writeMcp, 'manage_table', { action: 'delete', table_id: table.id })
})
