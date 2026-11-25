import { test, expect, request as pwRequest, type APIRequestContext, type Page } from '@playwright/test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { authedApi, seedSheet, BASE, makeAccessToken } from './helpers'
import { choose, openDataMenu } from './helpers-ui'
import { mcpClient, call, callError } from './helpers-mcp'

// Auto-delete on a webhook sheet (services/webhook-auto-delete*.ts): set up in the Webhook drawer
// (components/webhook/WebhookAutoDelete.tsx), after a confirm that says the rows can't be restored; events then
// sent to the real public endpoint leave the sheet past the newest rows kept, copied first to another sheet of
// the table, in order, without the webhook's column, while a row typed before the webhook stays; the drawer
// counts them, and turns it off. Over /api/v1/sheets/:id/webhook/auto-delete and manage_sheet_webhook: a write
// key sets it (what a call leaves out stays, null clears), a read key sees it and can't change it, bad settings
// and unknown fields are refused, and it turns off. Rules mode: set in the drawer with the filter's rule editor,
// rows that match leave and the rest stay; over REST and MCP, rules are checked and a mode change clears them.

let api: APIRequestContext
let sender: APIRequestContext
let reader: APIRequestContext
let writer: APIRequestContext
let readMcp: Client
let writeMcp: Client

const bearer = (token: string) =>
  pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${token}` } })
const rows = async (sheetId: string) =>
  (await (await reader.get(`/api/v1/sheets/${sheetId}/rows?limit=100`)).json()).rows as
    Array<{ index: number; data: Record<string, string> }>
const section = (page: Page) => page.getByTestId('webhook-auto-delete')

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  api = await authedApi()
  sender = await pwRequest.newContext({ baseURL: BASE })
  reader = await bearer(await makeAccessToken(api, ['read'], 'e2e auto-delete read'))
  writer = await bearer(await makeAccessToken(api, ['read', 'write'], 'e2e auto-delete write'))
  readMcp = await mcpClient(await makeAccessToken(api, ['read'], 'e2e auto-delete mcp read'))
  writeMcp = await mcpClient(await makeAccessToken(api, ['read', 'write'], 'e2e auto-delete mcp write'))
})
test.afterAll(async () => {
  await Promise.all([readMcp?.close(), writeMcp?.close(), sender?.dispose(), reader?.dispose(), writer?.dispose()])
})

test('Webhook drawer: auto-delete keeps the newest rows and copies older ones to another sheet',
  async ({ page, context }) => {
  test.setTimeout(120_000)
  const { tableId, sheetId } = await seedSheet(api, 1)
  const made = await (await api.post(`/api/sheets/${sheetId}/webhook`, { data: {} })).json()
  const url = new URL(made.source.url, BASE).href
  expect((await api.post(`/api/sheets/${sheetId}/webhook/mappings`,
    { data: { jsonPath: '$.email', columnName: 'Email' } })).status()).toBe(201)
  const archive = (await (await api.post(`/api/tables/${tableId}/sheets`, { data: { name: 'Archive' } })).json()).sheet
  expect(typeof archive.id).toBe('string')
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })

  await openDataMenu(page, 'Webhook')
  await expect(section(page)).toContainText('Off. Keep a busy webhook sheet small')
  await section(page).getByRole('button', { name: 'Set up auto-delete' }).click()
  await page.getByTestId('webhook-auto-delete-keep').fill('2')
  await page.getByTestId('webhook-auto-delete-copy').selectOption({ label: 'Archive' })
  await page.getByTestId('webhook-auto-delete-save').click()
  // It asks first, and says the rows can't be restored; nothing is on until it is confirmed.
  const asked = page.getByRole('dialog').filter({ hasText: 'Turn on auto-delete?' })
  await expect(asked).toContainText('Rows the webhook added, older than the newest 2, are deleted once every column '
    + "with auto-run on has run on them. They don't go to the trash and can't be restored.")
  expect((await (await api.get(`/api/sheets/${sheetId}/webhook`)).json()).source.autoDelete).toBeNull()
  await asked.getByRole('button', { name: 'Turn on' }).click()
  await expect(page.getByTestId('webhook-auto-delete-state')).toHaveText('Keeps the newest 2 rows. Older rows the '
    + 'webhook added are deleted once every column with auto-run on has run on them, copied to "Archive" first.')

  for (let i = 0; i < 5; i++) {
    expect((await sender.post(url, { data: { email: `a${i}@x.com` } })).status()).toBe(202)
  }
  // The sweep runs every few seconds: the first three events leave, the newest two stay, and so does the row
  // that was in the sheet before the webhook (it didn't come from it).
  await expect.poll(async () => (await rows(sheetId)).map(r => r.data.Email ?? r.data.val), { timeout: 30_000 })
    .toEqual(['v0', 'a3@x.com', 'a4@x.com'])
  const copied = await rows(archive.id)
  expect(copied.map(r => r.data.Email)).toEqual(['a0@x.com', 'a1@x.com', 'a2@x.com'])
  expect(copied.every(r => !('Webhook' in r.data))).toBe(true)

  await page.reload()
  await expect(page.locator('.ag-row[row-index]').first()).toBeVisible({ timeout: 15_000 })
  await openDataMenu(page, 'Webhook')
  await expect(page.getByTestId('webhook-auto-delete-count')).toContainText('3 rows deleted so far, the last')
  await section(page).getByRole('button', { name: 'Turn off' }).click()
  await expect(section(page)).toContainText('Off.')
  expect((await (await api.get(`/api/sheets/${sheetId}/webhook`)).json()).source.autoDelete).toBeNull()
})

test('REST and MCP: set with a write key, seen with a read key, refused when bad, turned off', async () => {
  const { tableId, sheetId } = await seedSheet(api, 1)
  const at = `/api/v1/sheets/${sheetId}/webhook`
  expect((await writer.post(at)).status()).toBe(201)
  const other = (await (await api.post(`/api/tables/${tableId}/sheets`, { data: { name: 'Kept' } })).json()).sheet

  const on = await writer.put(`${at}/auto-delete`, { data: { keep_rows: 5, copy_to_sheet_id: other.id } })
  expect(on.status()).toBe(200)
  expect((await on.json()).webhook.auto_delete).toEqual({ mode: 'actions_finish', where: null, keep_rows: 5,
    success_column: null, copy_to_sheet_id: other.id, copy_to_sheet: 'Kept', paused: null, waiting: null,
    rows_deleted: 0, last_deleted_at: null })
  expect((await (await reader.get(at)).json()).webhook.auto_delete.keep_rows).toBe(5)
  expect((await reader.put(`${at}/auto-delete`, { data: {} })).status()).toBe(403)
  const bad = await writer.put(`${at}/auto-delete`, { data: { keep_rows: -1 } })
  expect(bad.status()).toBe(400)
  expect((await bad.json()).error).toBe('keep_rows is a whole number from 0 to 100,000.')
  expect((await (await writer.put(`${at}/auto-delete`, { data: { copy_to_sheet_id: sheetId } })).json()).error)
    .toBe("Rows can't be copied to the sheet they leave.")
  const unknown = await writer.put(`${at}/auto-delete`, { data: { keepRows: 5 } })
  expect(unknown.status()).toBe(400)
  expect((await unknown.json()).error).toBe('Unknown field: keepRows.')
  // What a call leaves out stays; null clears.
  const again = await (await writer.put(`${at}/auto-delete`, { data: { success_column: 'val' } })).json()
  expect(again.webhook.auto_delete).toMatchObject({ keep_rows: 5, success_column: 'val', copy_to_sheet_id: other.id })
  const cleared = await (await writer.put(`${at}/auto-delete`, { data: { copy_to_sheet_id: null } })).json()
  expect(cleared.webhook.auto_delete).toMatchObject({ keep_rows: 5, success_column: 'val', copy_to_sheet_id: null })
  expect((await (await writer.delete(`${at}/auto-delete`)).json()).webhook.auto_delete).toBeNull()

  const set = await call(writeMcp, 'manage_sheet_webhook',
    { action: 'set_auto_delete', sheet_id: sheetId, keep_rows: 3, success_column: 'val' })
  expect(set.webhook.auto_delete).toMatchObject({ keep_rows: 3, success_column: 'val', copy_to_sheet: null })
  expect(await callError(writeMcp, 'manage_sheet_webhook', { action: 'get', sheet_id: sheetId, keep_rows: 3 }))
    .toContain('mode, where, keep_rows, success_column and copy_to_sheet_id are for set_auto_delete.')
  expect(await callError(readMcp, 'manage_sheet_webhook', { action: 'set_auto_delete', sheet_id: sheetId }))
    .toMatch(/write/)
  expect((await call(readMcp, 'manage_sheet_webhook', { action: 'get', sheet_id: sheetId })).webhook.auto_delete
    .keep_rows).toBe(3)
  const off = await call(writeMcp, 'manage_sheet_webhook', { action: 'auto_delete_off', sheet_id: sheetId })
  expect(off.webhook.auto_delete).toBeNull()
})

test('Webhook drawer: rules mode deletes the rows that match; REST and MCP set and check rules',
  async ({ page, context }) => {
  test.setTimeout(120_000)
  const { tableId, sheetId } = await seedSheet(api, 1)
  const made = await (await api.post(`/api/sheets/${sheetId}/webhook`, { data: {} })).json()
  const url = new URL(made.source.url, BASE).href
  expect((await api.post(`/api/sheets/${sheetId}/webhook/mappings`,
    { data: { jsonPath: '$.score', columnName: 'Score' } })).status()).toBe(201)
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })

  await openDataMenu(page, 'Webhook')
  await section(page).getByRole('button', { name: 'Set up auto-delete' }).click()
  await page.getByTestId('webhook-auto-delete-keep').fill('0')
  await page.getByTestId('webhook-auto-delete-mode').selectOption('rules')
  const rules = page.getByTestId('webhook-auto-delete-rules')
  await expect(page.getByTestId('webhook-auto-delete-success')).toBeHidden()
  // No rule with a value yet: nothing to save.
  await expect(page.getByTestId('webhook-auto-delete-save')).toBeDisabled()
  await rules.getByRole('button', { name: 'Add rule' }).click()
  const rule = rules.getByTestId('filter-rule').first()
  await choose(rule.getByLabel('Column'), 'Score')
  await choose(rule.getByLabel('Condition'), 'lt')
  // A rule without its value would match more rows: no save until it has one.
  await expect(page.getByTestId('webhook-auto-delete-unfinished')).toBeVisible()
  await expect(page.getByTestId('webhook-auto-delete-save')).toBeDisabled()
  await rule.getByLabel('Value').fill('5')
  await expect(page.getByTestId('webhook-auto-delete-unfinished')).toBeHidden()
  await page.getByTestId('webhook-auto-delete-save').click()
  const asked = page.getByRole('dialog').filter({ hasText: 'Turn on auto-delete?' })
  await expect(asked).toContainText('Rows the webhook added, older than the newest 0, are deleted once they match: ')
  await expect(asked).toContainText("whether or not auto-run has run on them. They don't go to the trash and can't "
    + 'be restored.')
  await asked.getByRole('button', { name: 'Turn on' }).click()
  await expect(page.getByTestId('webhook-auto-delete-state')).toContainText('Older rows the webhook added are '
    + 'deleted once they match: ')
  await expect(page.getByTestId('webhook-auto-delete-state')).toContainText('Score')

  for (const score of [1, 7, 3, 9]) {
    expect((await sender.post(url, { data: { score: String(score) } })).status()).toBe(202)
  }
  // Under 5 leaves; 7, 9 and the row typed before the webhook stay.
  await expect.poll(async () => (await rows(sheetId)).map(r => r.data.Score ?? r.data.val), { timeout: 30_000 })
    .toEqual(['v0', '7', '9'])

  const at = `/api/v1/sheets/${sheetId}/webhook/auto-delete`
  const noRules = await writer.put(at, { data: { where: null, mode: 'rules' } })
  expect(noRules.status()).toBe(400)
  expect((await noRules.json()).error).toBe('Mode "rules" needs where: the rules a row must pass.')
  const badRule = await writer.put(at, { data: { where: [{ column: 'Nope', operator: 'empty' }] } })
  expect(badRule.status()).toBe(400)
  expect((await badRule.json()).error).toContain('Nope')
  const more = await call(writeMcp, 'manage_sheet_webhook', { action: 'set_auto_delete', sheet_id: sheetId,
    where: [{ column: 'Score', operator: 'gt', value: '8' }] })
  expect(more.webhook.auto_delete).toMatchObject({ mode: 'rules', keep_rows: 0,
    where: [{ column: 'Score', operator: 'gt', value: '8' }] })
  const back = await call(writeMcp, 'manage_sheet_webhook',
    { action: 'set_auto_delete', sheet_id: sheetId, mode: 'actions_finish' })
  expect(back.webhook.auto_delete).toMatchObject({ mode: 'actions_finish', where: null, keep_rows: 0 })
})
