import { test, expect, type Page } from '@playwright/test'
import { authedApi, seedSheet, importCsv, BASE } from './helpers'
import { makeToken } from './api-v1-run-helpers'
import { mcpClient, call, callError } from './helpers-mcp'

// "Copy values to a new sheet" (services/sheet-copy*.ts): from a tab's menu
// at 1280px, over /api/v1 and as MCP manage_sheet copy. The copy goes right
// after its source and opens, holding the rows in order under plain columns
// (a formula column's values come along, its formula doesn't), with a run's
// words left empty. Screenshots land in test-results/shots/.
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/shots/${name}.png` })
const CSV = 'Name,Website,Status\nAda,acme.com,⏭️ Not found\nBo,navy.mil,✅ Found\nCy,initech.io,❌ Failed: timeout\n'

test('copy values from the sheet tab menu: the copy opens after its source', async ({ page, context }) => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const { tableId, sheetId } = await seedSheet(api, 1)
  expect((await importCsv(api, sheetId, CSV, { replaceData: true })).ok()).toBeTruthy()
  const client = await mcpClient(await makeToken(api, ['read', 'write'], 'sheet copy ui'))
  await call(client, 'formula_column', { sheet_id: sheetId, column: 'Domain', formula: '{{Website}}?.split(".")[0]' })
  await call(client, 'manage_sheet', { action: 'create', table_id: tableId, name: 'Later' })

  await page.setViewportSize({ width: 1280, height: 800 })
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  await page.locator('[aria-label^="Sheet options for"]').first().click()
  await expect(page.getByTestId('copy-sheet-values')).toHaveText('Copy values to a new sheet')
  await shot(page, 'sheet-copy-menu')
  await page.getByTestId('copy-sheet-values').click()
  await expect(page.getByText('Copied 3 rows to "Copy of Sheet1"')).toBeVisible({ timeout: 15_000 })
  const tabs = page.locator('[aria-label^="Sheet options for"]')
  await expect(tabs).toHaveCount(3)
  await expect(tabs.nth(1)).toHaveAttribute('aria-label', 'Sheet options for Copy of Sheet1')
  await expect(page.locator('[aria-current="page"]')).toHaveText('Copy of Sheet1')
  await expect(page).toHaveURL(/\/table\/[^/]+\/[^/]+$/)
  const copyId = page.url().split('/').pop()!
  expect(copyId).not.toBe(sheetId)
  await expect(page.locator('.ag-center-cols-container .ag-row[row-index="2"]')).toContainText('Cy')
  await shot(page, 'sheet-copy-opened')

  const got = await call(client, 'get_sheet', { sheet_id: copyId })
  expect(got.columns).toEqual(['Name', 'Website', 'Status', 'Domain'])
  expect(got.column_details.map((c: { kind: string }) => c.kind)).toEqual(['plain', 'plain', 'plain', 'plain'])
  const rows = await call(client, 'read_rows', { sheet_id: copyId })
  expect(rows.rows.map((r: { data: Record<string, string> }) => [r.data.Name, r.data.Status ?? '', r.data.Domain]))
    .toEqual([['Ada', '', 'acme'], ['Bo', '✅ Found', 'navy'], ['Cy', '', 'initech']])
  const history = await (await api.get(`/api/sheets/${copyId}/history`)).json()
  expect(JSON.stringify(history)).toContain('Copied the values of 3 rows from \\"Sheet1\\"')
})

test('copy over /api/v1 and MCP: name, columns, refusals and scopes', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  const { tableId, sheetId } = await seedSheet(api, 1)
  expect((await importCsv(api, sheetId, CSV, { replaceData: true })).ok()).toBeTruthy()
  const token = await makeToken(api, ['read', 'write'], 'sheet copy api')
  const headers = { Authorization: `Bearer ${token}` }
  const post = (body: unknown, id = sheetId) => api.post(`${BASE}/api/v1/sheets/${id}/copy`, { headers, data: body })

  const res = await post({ name: 'Snapshot', columns: ['Website', 'Name'] })
  expect(res.status()).toBe(201)
  const made = await res.json()
  expect(made).toMatchObject({ sheet: { name: 'Snapshot', position: 1 }, rows_copied: 3, columns: ['Website', 'Name'] })
  expect(made.sheets.map((s: { id: string }) => s.id)).toEqual([sheetId, made.sheet.id])
  const read = await (await api.get(`${BASE}/api/v1/sheets/${made.sheet.id}/rows`, { headers })).json()
  expect(read.rows.map((r: { data: Record<string, string> }) => r.data))
    .toEqual([{ Website: 'acme.com', Name: 'Ada' }, { Website: 'navy.mil', Name: 'Bo' },
      { Website: 'initech.io', Name: 'Cy' }])

  expect((await post({ name: 'snapshot' })).status()).toBe(409)
  const bad = await post({ columns: ['Nope'] })
  expect(bad.status()).toBe(400)
  expect((await bad.json()).error).toContain('No column named "Nope"')
  expect((await post({}, '00000000-0000-4000-8000-000000000000')).status()).toBe(404)
  const reader = await makeToken(api, ['read'], 'sheet copy reader')
  const refused = await api.post(`${BASE}/api/v1/sheets/${sheetId}/copy`, {
    headers: { Authorization: `Bearer ${reader}` }, data: {},
  })
  expect(refused.status()).toBe(403)

  const client = await mcpClient(token)
  const copied = await call(client, 'manage_sheet', { action: 'copy', table_id: tableId, sheet_id: sheetId })
  expect(copied).toMatchObject({ sheet: { name: 'Copy of Sheet1', position: 1 }, rows_copied: 3 })
  expect(copied.columns).toEqual(['Name', 'Website', 'Status'])
  expect(copied.sheets.map((s: { name: string }) => s.name)).toEqual(['Sheet1', 'Copy of Sheet1', 'Snapshot'])
  expect(await callError(client, 'manage_sheet', { action: 'copy', table_id: tableId }))
    .toContain('sheet_id is required')
  const other = await call(client, 'manage_table', { action: 'create', name: `Other ${Date.now()}` })
  expect(await callError(client, 'manage_sheet', { action: 'copy', table_id: other.id, sheet_id: sheetId }))
    .toBe('Sheet not found')
})
