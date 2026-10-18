import { test, expect, request as pwRequest, type Page } from '@playwright/test'
import { authedApi, seedSheet, makeAccessToken, BASE } from './helpers'
import { mcpClient, call, callError } from './helpers-mcp'

// Row filters on run state, lists and OR groups, through every surface: REST
// rows/query and rows, MCP read_rows and export_csv, and the grid's column
// menu (Rows with errors, Run state, Is any of), with saved filters that
// follow a column rename and go with a delete. The run is a real AI run whose
// rows fail fast for free on a fake OpenRouter key.

const header = (page: Page, name: string) => page.locator('.ag-header-cell').filter({ hasText: name }).first()
const openMenu = async (page: Page, name: string) => {
  await header(page, name).locator('.ag-header-cell-text').first().click()
}
const shownVals = async (page: Page) => (await page.locator('.ag-center-cols-container .ag-row').allInnerTexts())
  .map(t => t.split('\n').find(x => /^v\d$/.test(x.trim()))?.trim()).filter(Boolean).sort()

test('run-state filters, lists and OR groups: REST, MCP and the grid', async ({ page, context }) => {
  test.setTimeout(180_000)
  const api = await authedApi()
  const { tableId, sheetId } = await seedSheet(api, 6)
  await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: 'Industry' } })
  const industries = ['SaaS', 'Fintech', 'saas', 'Retail', '', 'MÜNCHEN']
  expect((await api.put(`/api/sheets/${sheetId}/data`, { data: {
    updates: industries.map((value, rowIndex) => ({ rowIndex, columnName: 'Industry', value })) } })).ok()).toBeTruthy()
  const token = await makeAccessToken(api, ['read', 'write', 'run'], 'row-filters')
  const client = await mcpClient(token)
  const v1 = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${token}` } })

  // An AI column run on the first three rows only: they fail, the rest never run.
  const first = await call(client, 'read_rows', { sheet_id: sheetId, limit: 3 })
  expect((await api.put('/api/settings/openrouter-key', { data: { apiKey: 'sk-or-v1-invalid-e2e' } })).ok())
    .toBeTruthy()
  try {
    const ai = await call(client, 'run_ai_column', { sheet_id: sheetId, column_name: 'Fit', prompt: 'Is /val a fit?',
      model: 'deepseek/deepseek-v4-flash', target_row_ids: first.rows.map((r: { id: string }) => r.id) })
    await expect.poll(async () => (await call(client, 'get_run_status', { run_type: 'ai', run_id: ai.run_id }))
      .status, { timeout: 30_000 }).toMatch(/completed|failed/)
  } finally {
    await api.delete('/api/settings/openrouter-key')
  }

  // REST: run state with and without a column, counts, OR groups, lists, include_status.
  const query = async (body: Record<string, unknown>) => {
    const res = await v1.post(`/api/v1/sheets/${sheetId}/rows/query`, { data: body })
    return { status: res.status(), body: await res.json() }
  }
  const vals = (r: { body: { rows: Array<{ data: { val: string } }> } }) => r.body.rows.map(x => x.data.val)
  expect((await query({ where: [{ operator: 'has_error' }], return_mode: 'count' })).body.count).toBe(3)
  expect(vals(await query({ where: [{ column: 'Fit (Output)', operator: 'not_run' }] }))).toEqual(['v3', 'v4', 'v5'])
  expect(vals(await query({ where: [{ or: [
    { column: 'Industry', operator: 'any_of', values: ['SAAS'] }, { column: 'Industry', operator: 'empty' }] }] })))
    .toEqual(['v0', 'v2', 'v4'])
  expect(vals(await query({ where: [{ column: 'Industry', operator: 'eq', value: 'münchen' },
    { operator: 'not_run' }] }))).toEqual(['v5'])
  const withStatus = await query({ where: [{ operator: 'has_error' }], include_status: true, limit: 1 })
  expect(withStatus.body.rows[0].data['Fit (Output)']).toMatchObject({ status: 'error', value: null })
  expect(withStatus.body.rows[0].data['Fit (Output)'].error).toBeTruthy()
  expect(withStatus.body.rows[0].data.Industry).toBe('SaaS')
  const page2 = await (await v1.get(`/api/v1/sheets/${sheetId}/rows?limit=1&cursor=4&include_status=true`)).json()
  expect(page2.rows[0].data['Fit (Output)']).toEqual({ status: 'not_run', value: null, error: null })
  const refused = await query({ where: [{ column: 'Industry', operator: 'has_error' }] })
  expect(refused.status).toBe(400)
  expect(refused.body.error).toContain(`"Industry" isn't an AI, HTTP API or enrichment column`)
  expect((await query({ where: [{ or: [{ or: [] }] }] })).body.error).toContain('not other groups')

  // MCP: the same where, include_status, a count, an export, and a refusal.
  const failed = await call(client, 'read_rows', { sheet_id: sheetId, where: [{ operator: 'has_error' }],
    columns: ['val', 'Fit (Output)'], include_status: true })
  expect(failed.rows.map((r: { data: { val: string } }) => r.data.val)).toEqual(['v0', 'v1', 'v2'])
  expect(failed.rows[0].data['Fit (Output)'].status).toBe('error')
  expect((await call(client, 'read_rows', { sheet_id: sheetId, where: [{ operator: 'not_run' }],
    return_mode: 'count' })).count).toBe(3)
  const csv = await call(client, 'export_csv', { sheet_id: sheetId, columns: ['val'],
    where: [{ column: 'Industry', operator: 'not_any_of', values: ['saas', 'retail'] }, { operator: 'has_error' }] })
  expect(csv.csv).toBe('"val"\r\n"v1"')
  const noRun = [{ column: 'Industry', operator: 'running' }]
  expect(await callError(client, 'read_rows', { sheet_id: sheetId, where: noRun })).toContain('has no run state')

  // A save from before the new operators still filters the grid's read.
  expect((await api.put(`/api/sheets/${sheetId}/column-filters`, { data: { columnFilters: {
    Industry: { type: 'contains', value: 'saas' } } } })).ok()).toBeTruthy()
  expect((await (await api.get(`/api/sheets/${sheetId}?limit=50`)).json()).data.totalRows).toBe(2)
  const bad = await api.put(`/api/sheets/${sheetId}/column-filters`, { data: { columnFilters: {
    Industry: { type: 'gt', value: 'many' } } } })
  expect(bad.status()).toBe(400)
  expect((await bad.json()).error).toContain('numeric value')
  await api.put(`/api/sheets/${sheetId}/column-filters`, { data: { columnFilters: null } })

  // The grid: one click for the failed rows, the other states under Run state, Is any of.
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(header(page, 'Fit (Output)')).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => shownVals(page)).toEqual(['v0', 'v1', 'v2', 'v3', 'v4', 'v5'])
  await openMenu(page, 'Fit (Output)')
  await page.getByRole('menuitem', { name: /Rows with errors/ }).click()
  await expect.poll(() => shownVals(page)).toEqual(['v0', 'v1', 'v2'])
  const saved = await (await api.get(`/api/sheets/${sheetId}?limit=1`)).json()
  expect(JSON.parse(saved.sheet.column_filters)).toEqual({ 'Fit (Output)': { type: 'has_error' } })
  await openMenu(page, 'Fit (Output)')
  await page.getByRole('menuitem', { name: 'Run state' }).click()
  await page.getByRole('menuitem', { name: /Rows not run yet/ }).click()
  await expect.poll(() => shownVals(page)).toEqual(['v3', 'v4', 'v5'])
  await openMenu(page, 'Fit (Output)')
  await page.getByRole('menuitem', { name: 'Clear filter' }).click()
  await expect.poll(() => shownVals(page)).toEqual(['v0', 'v1', 'v2', 'v3', 'v4', 'v5'])

  await openMenu(page, 'Industry')
  await expect(page.getByRole('menuitem', { name: /Rows with errors/ })).toHaveCount(0)
  await page.getByLabel('Filter condition').selectOption('any_of')
  // Typed values (the picker also lists the column's values with counts).
  for (const value of ['saas', 'retail']) {
    await page.getByPlaceholder('Search or type a value…').fill(value)
    await page.getByPlaceholder('Search or type a value…').press('Enter')
  }
  await page.getByRole('button', { name: 'Apply' }).click()
  await expect.poll(() => shownVals(page)).toEqual(['v0', 'v2', 'v3'])
  await page.keyboard.press('Escape')

  // A rename carries the saved filter; a delete takes it away.
  expect((await api.put(`/api/sheets/${sheetId}/columns/Industry`, { data: { newName: 'Sector' } })).ok()).toBeTruthy()
  const renamed = await (await api.get(`/api/sheets/${sheetId}?limit=50`)).json()
  expect(JSON.parse(renamed.sheet.column_filters)).toEqual({ Sector: { type: 'any_of', values: ['saas', 'retail'] } })
  expect(renamed.data.totalRows).toBe(3)
  expect((await api.delete(`/api/sheets/${sheetId}/columns/Sector`)).ok()).toBeTruthy()
  const deleted = await (await api.get(`/api/sheets/${sheetId}?limit=50`)).json()
  expect(deleted.sheet.column_filters).toBeNull()
  expect(deleted.data.totalRows).toBe(6)

  // Filters on several columns that hide every row: one Clear filter takes them all off.
  expect((await api.put(`/api/sheets/${sheetId}/column-filters`, { data: { columnFilters: {
    val: { type: 'neq', value: 'v9' }, 'Fit (Output)': { type: 'running' } } } })).ok()).toBeTruthy()
  expect((await api.put(`/api/sheets/${sheetId}/empty-filter`, { data: { emptyFilter: { val: 'not_empty' } } })).ok())
    .toBeTruthy()
  await page.reload()
  await expect(page.getByText('All rows are hidden by a column filter')).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Clear filter' }).click()
  await expect.poll(() => shownVals(page)).toEqual(['v0', 'v1', 'v2', 'v3', 'v4', 'v5'])
  const cleared = await (await api.get(`/api/sheets/${sheetId}?limit=1`)).json()
  expect([cleared.sheet.column_filters, cleared.sheet.empty_filter]).toEqual([null, null])
})
