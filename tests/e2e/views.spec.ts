// Over 200 lines: one sheet walked through every view surface in order (REST, MCP, the grid's bar and menus, export,
// then rename/delete), each step building on the state the last one left.
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, request as pwRequest, type Page } from '@playwright/test'
import { authedApi, seedSheet, makeAccessToken, BASE } from './helpers'
import { mcpClient, call, callError } from './helpers-mcp'
import { choose } from './helpers-ui'

// Saved views through every surface: REST create/list/update/delete and reads
// through a view (rows/query, export), MCP get_sheet/read_rows/export_csv with
// a view, and the app: hide a column from its menu and the columns picker, new
// view, switch views, a ready-made view, export "this view" or the whole
// sheet; a column rename and delete rewrite every view. The run column is a
// real AI run whose rows fail fast for free on a fake OpenRouter key.
// SHOT_DIR=<dir> saves screenshots of each step.

const header = (page: Page, name: string) => page.locator('.ag-header-cell').filter({ hasText: name }).first()
const openMenu = async (page: Page, name: string) => {
  await header(page, name).locator('.ag-header-cell-text').first().click()
}
const shownVals = async (page: Page) => (await page.locator('.ag-center-cols-container .ag-row').allInnerTexts())
  .map(t => t.split('\n').find(x => /^v\d$/.test(x.trim()))?.trim()).filter(Boolean).sort()
const headers = async (page: Page) => (await page.locator('.ag-header-cell-text').allInnerTexts()).map(t => t.trim())
const shot = async (page: Page, name: string) => {
  if (!process.env.SHOT_DIR) return
  await page.waitForTimeout(400) // menus fade in
  await page.screenshot({ path: path.join(process.env.SHOT_DIR, `${name}.png`) })
}

test('saved views and hidden columns: REST, MCP, the grid and export', async ({ page, context }) => {
  test.setTimeout(180_000)
  const api = await authedApi()
  const { tableId, sheetId } = await seedSheet(api, 6)
  for (const columnName of ['Industry', 'Notes']) {
    await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName } })
  }
  const industries = ['SaaS', 'Fintech', 'saas', 'Retail', '', 'SaaS']
  expect((await api.put(`/api/sheets/${sheetId}/data`, { data: { updates: [
    ...industries.map((value, rowIndex) => ({ rowIndex, columnName: 'Industry', value })),
    ...industries.map((_, rowIndex) => ({ rowIndex, columnName: 'Notes', value: `note ${rowIndex}` })),
  ] } })).ok()).toBeTruthy()
  const token = await makeAccessToken(api, ['read', 'write', 'run'], 'views')
  const client = await mcpClient(token)
  const v1 = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${token}` } })

  // An AI column run on the first three rows: they fail, the rest never run.
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

  // REST: the Default view, a new one with filters and a hidden column, refusals.
  const listed = await (await v1.get(`/api/v1/sheets/${sheetId}/views`)).json()
  expect(listed.views.map((v: { name: string; active: boolean }) => [v.name, v.active])).toEqual([['Default', true]])
  const created = await v1.post(`/api/v1/sheets/${sheetId}/views`, { data: { name: 'SaaS', description: 'SaaS rows',
    where: [{ column: 'Industry', operator: 'eq', value: 'saas' }], hidden_columns: ['Notes'] } })
  expect(created.status()).toBe(201)
  const saas = (await created.json()).view
  expect(saas).toMatchObject({ name: 'SaaS', active: false, hidden_columns: ['Notes'] })
  expect((await v1.post(`/api/v1/sheets/${sheetId}/views`, { data: { name: 'saas' } })).status()).toBe(409)
  const def = listed.views[0].id
  expect((await v1.delete(`/api/v1/sheets/${sheetId}/views/${def}`)).status()).toBe(400)
  const badWhere = await v1.post(`/api/v1/sheets/${sheetId}/views`, { data: { name: 'Bad',
    where: [{ column: 'Nope', operator: 'empty' }] } })
  expect(badWhere.status()).toBe(400)
  expect((await badWhere.json()).error).toContain('Nope')

  // Reads through the view: its rows, its visible columns; `where` adds to it.
  const q = await (await v1.post(`/api/v1/sheets/${sheetId}/rows/query`, { data: { view: 'SaaS' } })).json()
  expect(q.rows.map((r: { data: { val: string } }) => r.data.val)).toEqual(['v0', 'v2', 'v5'])
  expect(Object.keys(q.rows[0].data)).toEqual(['val', 'Industry', 'Fit (Output)'])
  expect(q.view_version).toMatch(/^[0-9a-f]{16}$/)
  const page2 = await v1.post(`/api/v1/sheets/${sheetId}/rows/query`, { data: { view: 'SaaS', cursor: 0,
    expected_data_version: q.data_version, expected_row_generation: q.row_generation } })
  expect(page2.status()).toBe(400)
  expect((await page2.json()).error).toContain('expected_view_version')
  const page2ok = await (await v1.post(`/api/v1/sheets/${sheetId}/rows/query`, { data: { view: 'SaaS', cursor: 0,
    expected_data_version: q.data_version, expected_row_generation: q.row_generation,
    expected_view_version: q.view_version } })).json()
  expect(page2ok.rows.map((r: { data: { val: string } }) => r.data.val)).toEqual(['v2', 'v5'])
  const q2 = await (await v1.post(`/api/v1/sheets/${sheetId}/rows/query`, { data: { view: 'SaaS',
    where: [{ operator: 'has_error' }], return_mode: 'count' } })).json()
  expect(q2.count).toBe(2)
  const csv = await (await v1.get(`/api/v1/sheets/${sheetId}/export?view=SaaS`)).text()
  expect(csv.split('\r\n')[0]).toBe('"val","Industry","Fit (Output)"')
  expect(csv.trim().split('\r\n')).toHaveLength(4)
  expect((await v1.get(`/api/v1/sheets/${sheetId}/export?view=Nope`)).status()).toBe(400)

  // MCP reads views (it doesn't change them).
  const meta = await call(client, 'get_sheet', { sheet_id: sheetId })
  expect(meta.views.map((v: { name: string }) => v.name)).toEqual(['Default', 'SaaS'])
  expect(meta.views[1].where).toEqual([{ column: 'Industry', operator: 'eq', value: 'saas' }])
  const mcpRows = await call(client, 'read_rows', { sheet_id: sheetId, view: 'SaaS', return_mode: 'count' })
  expect(mcpRows.count).toBe(3)
  const mcpCsv = await call(client, 'export_csv', { sheet_id: sheetId, view: saas.id, columns: ['val'] })
  expect(mcpCsv.csv).toBe('"val"\r\n"v0"\r\n"v2"\r\n"v5"')
  expect(await callError(client, 'read_rows', { sheet_id: sheetId, view: 'Nope' })).toContain('No view "Nope"')

  // The grid: hide a column from its menu; it stays hidden after a reload.
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(header(page, 'Notes')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('view-menu')).toHaveText(/Default/)
  await expect(page.getByTestId('columns-picker')).toHaveText(/4\/4 columns/)
  await openMenu(page, 'Notes')
  await page.getByRole('menuitem', { name: 'Hide column' }).click()
  await expect.poll(() => headers(page)).not.toContain('Notes')
  await expect(page.getByTestId('columns-picker')).toHaveText(/3\/4 columns/)
  await shot(page, '01-hidden-from-header-menu')
  await page.reload()
  await expect(header(page, 'Industry')).toBeVisible({ timeout: 15_000 })
  expect(await headers(page)).not.toContain('Notes')

  // The columns picker: hide Industry, show Notes again.
  await page.getByTestId('columns-picker').click()
  await shot(page, '02-columns-picker')
  await page.getByTestId('column-toggle').filter({ hasText: 'Industry' }).click()
  await page.getByTestId('column-toggle').filter({ hasText: 'Notes' }).click()
  await page.keyboard.press('Escape')
  await expect.poll(() => headers(page)).toEqual(expect.arrayContaining(['Notes']))
  expect(await headers(page)).not.toContain('Industry')
  await expect.poll(async () => (await (await v1.get(`/api/v1/sheets/${sheetId}/views`)).json())
    .views[0].hidden_columns).toEqual(['Industry'])

  // Switch views: the SaaS view's rows and hidden column.
  await page.getByTestId('view-menu').click()
  await shot(page, '03-view-menu')
  await page.getByTestId('view-option').filter({ hasText: 'SaaS' }).click()
  await expect(page.getByTestId('view-menu')).toHaveText(/SaaS/)
  await expect.poll(() => shownVals(page)).toEqual(['v0', 'v2', 'v5'])
  expect(await headers(page)).toContain('Industry')
  expect(await headers(page)).not.toContain('Notes')
  await shot(page, '04-switched-to-saas')

  // A filter changed here belongs to this view only.
  await openMenu(page, 'Industry')
  await choose(page.getByLabel('Filter condition'), 'any_of')
  // Typed values (the picker also lists the column's values with counts).
  for (const value of ['saas', 'retail']) {
    await page.getByPlaceholder('Search or type a value…').fill(value)
    await page.getByPlaceholder('Search or type a value…').press('Enter')
  }
  await page.getByRole('button', { name: 'Apply' }).click()
  await page.keyboard.press('Escape')
  await expect.poll(() => shownVals(page)).toEqual(['v0', 'v2', 'v3', 'v5'])

  // A ready-made view: rows where any run column has an error.
  await page.getByTestId('view-menu').click()
  await page.getByRole('menuitem', { name: 'Rows with errors' }).click()
  await expect(page.getByTestId('view-menu')).toHaveText(/Rows with errors/)
  await expect.poll(() => shownVals(page)).toEqual(['v0', 'v1', 'v2'])
  await expect(page.getByTestId('filter-button')).toContainText('has an error')
  await shot(page, '05-rows-with-errors')

  // Export: this view (its rows and visible columns) or the whole sheet.
  await page.getByTestId('data-menu').click()
  await shot(page, '06-export-choice')
  const download = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: /^Export this view/ }).click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/ - Rows with errors\.csv$/)
  const exported = fs.readFileSync((await file.path())!, 'utf8').trim().split(/\r?\n/)
  expect(exported[0]).toBe('"val","Industry","Notes","Fit (Output)"')
  expect(exported).toHaveLength(4)
  await expect(page.getByTestId('data-menu')).not.toHaveAttribute('aria-busy', 'true') // that export is done
  await page.getByTestId('data-menu').click()
  const whole = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: /^Export whole sheet/ }).click()
  expect(fs.readFileSync((await (await whole).path())!, 'utf8').trim().split(/\r?\n/)).toHaveLength(7)

  // Clearing the view's filter shows every row in this view.
  await page.getByLabel('Clear all filters').click()
  await expect.poll(() => shownVals(page)).toEqual(['v0', 'v1', 'v2', 'v3', 'v4', 'v5'])

  // New view: a copy of the one showing, then renamed; deleting it goes back to Default.
  await page.getByTestId('view-menu').click()
  await page.getByRole('menuitem', { name: 'New view…' }).click()
  await page.getByTestId('view-name').fill('My leads')
  await shot(page, '07-new-view-dialog')
  await page.getByTestId('view-dialog-submit').click()
  await expect(page.getByTestId('view-menu')).toHaveText(/My leads/)
  await page.getByTestId('view-menu').click()
  await page.getByRole('menuitem', { name: 'Delete view' }).click()
  await page.getByTestId('view-dialog-submit').click()
  await expect(page.getByTestId('view-menu')).toHaveText(/Default/)
  expect(await headers(page)).not.toContain('Industry')

  // A rename carries every view's filters and hidden columns; a delete drops them.
  expect((await api.put(`/api/sheets/${sheetId}/columns/Industry`, { data: { newName: 'Sector' } })).ok()).toBeTruthy()
  const views = (await (await v1.get(`/api/v1/sheets/${sheetId}/views`)).json()).views
  expect(views[0].hidden_columns).toEqual(['Sector'])
  expect(views.find((v: { name: string }) => v.name === 'SaaS').where)
    .toEqual([{ column: 'Sector', operator: 'any_of', values: ['saas', 'retail'] }])
  expect((await api.delete(`/api/sheets/${sheetId}/columns/Notes`)).ok()).toBeTruthy()
  const after = (await (await v1.get(`/api/v1/sheets/${sheetId}/views`)).json()).views
  expect(after.find((v: { name: string }) => v.name === 'SaaS').hidden_columns).toEqual([])
})
