import { createHmac } from 'node:crypto'
import { test, expect, type APIRequestContext } from '@playwright/test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { authedApi, seedSheet, makeAccessToken } from './helpers'
import { mcpClient, call, callError } from './helpers-mcp'
import { Receiver, type Hit } from './helpers-receiver'

// The MCP tools for what REST already had, on the same services: manage_view
// (create a view without switching the app, read through it, change, clear,
// delete; duplicate names, unknown columns, the Default view and read tokens
// refused), set_column_order (rows untouched; a partial, unknown or repeated
// order changes nothing) and manage_run_webhook (private URLs and tokens
// without run refused, the secret shown once, a signed test notice, a new
// secret replaces the old one, change, delete), through the real outbound
// path to a local receiver (tests/e2e/net-shim.cjs).
const rx = new Receiver()
let api: APIRequestContext
let client: Client
let readOnly: Client
let writeOnly: Client
let sheetId: string

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  await rx.start()
  rx.on('/mcp-hook', { status: 200, body: '{"ok":true}' })
  api = await authedApi()
  ;({ sheetId } = await seedSheet(api, 4))
  for (const columnName of ['Industry', 'Notes']) {
    expect((await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName } })).ok()).toBeTruthy()
  }
  const updates = ['SaaS', 'Retail', 'saas', ''].map((value, rowIndex) => ({ rowIndex, columnName: 'Industry', value }))
  expect((await api.put(`/api/sheets/${sheetId}/data`, { data: { updates } })).ok()).toBeTruthy()
  client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'mcp views order hooks'))
  readOnly = await mcpClient(await makeAccessToken(api, ['read'], 'mcp views order hooks read'))
  writeOnly = await mcpClient(await makeAccessToken(api, ['read', 'write'], 'mcp views order hooks write'))
})
test.afterAll(async () => {
  // A failed run of this spec mustn't leave a webhook that hears later specs' runs.
  for (const h of (await (await api.get('/api/settings/run-webhooks')).json()).webhooks ?? []) {
    if (String(h.url).includes('/mcp-hook')) await api.delete(`/api/settings/run-webhooks/${h.id}`)
  }
  await rx.stop()
  await Promise.all([client?.close(), readOnly?.close(), writeOnly?.close()])
})

const views = async () => (await call(client, 'get_sheet', { sheet_id: sheetId })).views as
  Array<{ name: string; active: boolean; hidden_columns: string[]; where: unknown[] }>
const SAAS = [{ column: 'Industry', operator: 'eq', value: 'saas' }]

test('manage_view: create, read through it, change, clear and delete; what it refuses', async () => {
  const made = await call(client, 'manage_view', {
    sheet_id: sheetId, action: 'create', name: 'SaaS', description: 'SaaS companies', where: SAAS,
    hidden_columns: ['Notes'],
  })
  expect(made.view).toMatchObject({ name: 'SaaS', description: 'SaaS companies', is_default: false, active: false,
    hidden_columns: ['Notes'], where: SAAS })
  expect((await views()).map(v => [v.name, v.active])).toEqual([['Default', true], ['SaaS', false]])
  const through = await call(client, 'read_rows', { sheet_id: sheetId, view: 'SaaS' })
  expect(through.rows.map((r: { data: { Industry: string } }) => r.data.Industry).sort()).toEqual(['SaaS', 'saas'])
  const csv = (await call(client, 'export_csv', { sheet_id: sheetId, view: 'SaaS' })).csv as string
  expect(csv.split('\r\n')[0]).toBe('"val","Industry"')

  expect(await callError(client, 'manage_view', { sheet_id: sheetId, action: 'create', name: 'saas' }))
    .toMatch(/already exists/)
  expect(await callError(client, 'manage_view', {
    sheet_id: sheetId, action: 'create', name: 'Bad', where: [{ column: 'Nope', operator: 'empty' }],
  })).toMatch(/Nope/)
  expect(await callError(client, 'manage_view', { sheet_id: sheetId, action: 'create', name: 'X', view: 'SaaS' }))
    .toMatch(/leave view out/)
  expect(await callError(client, 'manage_view', { sheet_id: sheetId, action: 'change', name: 'X' }))
    .toMatch(/change needs view/)
  expect(await callError(client, 'manage_view', { sheet_id: sheetId, action: 'change', view: 'SaaS' }))
    .toMatch(/at least one of/)
  expect(await callError(readOnly, 'manage_view', { sheet_id: sheetId, action: 'create', name: 'R' }))
    .toMatch(/'write' scope/)

  const changed = await call(client, 'manage_view', {
    sheet_id: sheetId, action: 'change', view: made.view.id, name: 'Everyone', where: null, hidden_columns: null,
  })
  expect(changed.view).toMatchObject({ id: made.view.id, name: 'Everyone', hidden_columns: [], where: [] })
  expect((await call(client, 'read_rows', { sheet_id: sheetId, view: 'Everyone', return_mode: 'count' })).count)
    .toBe(4)

  expect(await callError(client, 'manage_view', { sheet_id: sheetId, action: 'delete', view: 'Default' }))
    .toMatch(/Default view can't be deleted/)
  expect(await call(client, 'manage_view', { sheet_id: sheetId, action: 'delete', view: 'Everyone' }))
    .toEqual({ ok: true })
  expect((await views()).map(v => v.name)).toEqual(['Default'])
  expect(await callError(client, 'manage_view', { sheet_id: sheetId, action: 'delete', view: 'Everyone' }))
    .toMatch(/not found/)
})

test('set_column_order: the new order, rows untouched; partial, unknown or repeated orders are refused', async () => {
  const columns = async () => (await call(client, 'get_sheet', { sheet_id: sheetId })).columns
  const cells = async () => (await call(client, 'read_rows', { sheet_id: sheetId })).rows
    .map((r: { data: Record<string, string> }) => r.data)
  const before = await cells()
  expect(await columns()).toEqual(['val', 'Industry', 'Notes'])
  expect(await call(client, 'set_column_order', { sheet_id: sheetId, order: ['Notes', 'val', 'Industry'] }))
    .toEqual({ order: ['Notes', 'val', 'Industry'] })
  expect(await columns()).toEqual(['Notes', 'val', 'Industry'])
  expect(await cells()).toEqual(before)

  const refused = async (order: string[], why: RegExp) =>
    expect(await callError(client, 'set_column_order', { sheet_id: sheetId, order })).toMatch(why)
  await refused(['val', 'Industry'], /Missing: Notes/)
  await refused(['Notes', 'val', 'Industry', 'Nope'], /Invalid columns in order: Nope/)
  await refused(['Notes', 'val', 'val', 'Industry'], /Duplicate column/)
  expect(await callError(readOnly, 'set_column_order', { sheet_id: sheetId, order: ['val', 'Industry', 'Notes'] }))
    .toMatch(/'write' scope/)
  expect(await callError(client, 'set_column_order', { sheet_id: 'no-such-sheet', order: ['val'] }))
    .toMatch(/Sheet not found/)
  expect(await columns()).toEqual(['Notes', 'val', 'Industry'])
})

test('manage_run_webhook: create, a signed test, a new secret, change, delete; what it refuses', async () => {
  const signed = (secret: string, hit: Hit) =>
    hit.headers['x-cubex-signature'] === `sha256=${createHmac('sha256', secret).update(hit.body).digest('hex')}`
  const hook = (args: Record<string, unknown>) => call(client, 'manage_run_webhook', args)
  const refused = (args: Record<string, unknown>, who = client) => callError(who, 'manage_run_webhook', args)
  const url = rx.url('/mcp-hook', 'mcp')

  expect(await refused({ action: 'create', url }, writeOnly)).toMatch(/'run' scope/)
  expect(await refused({ action: 'create', url: 'http://127.0.0.1:9/mcp-hook' })).toMatch(/public addresses/)
  const made = await hook({ action: 'create', url, every_run: false })
  expect(made.webhook).toMatchObject({ url, every_run: false, last_delivery: null })
  expect(made.secret).toEqual(expect.any(String))
  const id = made.webhook.id
  expect(JSON.stringify(await call(client, 'list_run_webhooks', {}))).not.toContain(made.secret)
  expect(await refused({ action: 'create', url })).toMatch(/already a run webhook/)

  const first = (await hook({ action: 'test', webhook_id: id })).delivery
  expect(first).toMatchObject({ event: 'test', state: 'delivered', response_code: 200, tries: 1 })
  const hit = rx.hitsOn('/mcp-hook').find(h => h.headers['x-cubex-delivery'] === first.id)!
  expect(JSON.parse(hit.body)).toMatchObject({ event: 'test', run_id: null, status: null })
  expect(signed(made.secret, hit)).toBe(true)

  const fresh = (await hook({ action: 'new_secret', webhook_id: id })).secret
  expect(fresh).not.toBe(made.secret)
  const second = (await hook({ action: 'test', webhook_id: id })).delivery
  const hit2 = rx.hitsOn('/mcp-hook').find(h => h.headers['x-cubex-delivery'] === second.id)!
  expect(signed(fresh, hit2)).toBe(true)
  expect(signed(made.secret, hit2)).toBe(false)

  const moved = rx.url('/mcp-hook', 'mcp-moved')
  expect((await hook({ action: 'change', webhook_id: id, url: moved, every_run: true })).webhook)
    .toMatchObject({ id, url: moved, every_run: true })
  expect(await refused({ action: 'change', webhook_id: id })).toMatch(/change needs url or every_run/)
  expect(await refused({ action: 'test' })).toMatch(/test needs webhook_id/)
  expect(await refused({ action: 'delete', webhook_id: id, url })).toMatch(/for create and change/)
  expect(await refused({ action: 'create', url, webhook_id: id })).toMatch(/leave webhook_id out/)

  expect(await hook({ action: 'delete', webhook_id: id })).toEqual({ deleted: true })
  expect(await refused({ action: 'test', webhook_id: id })).toMatch(/not found/)
  expect((await call(client, 'list_run_webhooks', {})).webhooks.some((h: { id: string }) => h.id === id)).toBe(false)
})
