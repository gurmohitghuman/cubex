import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import { authedApi, seedSheet, getSheet, BASE } from './helpers'
import { choose } from './helpers-ui'

// The app's Clean data flow: "+ Add Column" offers Clean data, the preview
// shows before and after, the new column gets its icon and values, its menu
// edits it and switches auto-run, every column's menu opens Clean data on it,
// and an edit to the source reaches the clean column on its own. The first-
// and last-name cleaners ask what the column holds, company name what "The ...
// Company" becomes; the choice reaches the preview, the column and Edit cleaning.

const NAMES = ['SMITH, JOHN', 'jane doe', 'Dr. Mary O\'Brien']

async function seedNames(api: APIRequestContext) {
  const { tableId, sheetId } = await seedSheet(api, NAMES.length)
  await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: 'Name' } })
  const updates = NAMES.map((value, rowIndex) => ({ rowIndex, columnName: 'Name', value }))
  expect((await api.put(`/api/sheets/${sheetId}/data`, { data: { updates } })).ok()).toBeTruthy()
  return { tableId, sheetId }
}

const header = (page: Page, name: string) => page.locator('.ag-header-cell').filter({ hasText: name }).first()
async function openMenu(page: Page, name: string) {
  await header(page, name).locator('.ag-header-cell-text').first().click()
  await expect(page.getByRole('menu')).toBeVisible()
}
// The grid's scrolling part (the row number and checkbox sit in a pinned part of their own).
const row = (page: Page, i: number) => page.locator(`.ag-center-cols-container .ag-row[row-index="${i}"]`)
const cleanValues = async (api: APIRequestContext, sheetId: string) =>
  (await getSheet(api, sheetId)).data.rows.map((r: any) => r.data['Name (clean)'] ?? '')

test('Clean data from the Add Column dialog and the column menu', async ({ page, context }) => {
  test.setTimeout(120_000)
  const api = await authedApi()
  const { tableId, sheetId } = await seedNames(api)
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: /add new column/i }).click()
  await page.getByTestId('new-column-clean').click()
  const form = page.getByTestId('clean-column-form')
  await choose(form.locator('#clean-source'), 'Name')
  await choose(form.locator('#clean-cleaner'), 'person_name')
  await expect(page.getByTestId('clean-cleaner-help')).toContainText('ALL CAPS')
  await expect(form).toContainText('John Smith', { timeout: 10_000 })
  await expect(form.locator('#clean-name')).toHaveAttribute('placeholder', 'Name (clean)')
  await expect(page.getByTestId('clean-autorun')).toBeChecked()
  await page.getByTestId('clean-submit').click()

  await expect(header(page, 'Name (clean)')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('clean-icon')).toHaveCount(1)
  await expect(row(page, 0)).toContainText('John Smith', { timeout: 15_000 })
  expect(await cleanValues(api, sheetId)).toEqual(['John Smith', 'Jane Doe', 'Mary O\'Brien'])

  // Its menu: edit, clean again, auto-run (on by default).
  await openMenu(page, 'Name (clean)')
  const menu = page.getByRole('menu')
  for (const t of ['Clean Data Actions', 'Edit cleaning', 'Clean all rows again', 'Turn Off Auto-run']) {
    await expect(menu).toContainText(t)
  }
  await page.getByRole('menuitem', { name: /Edit cleaning/ }).click()
  await expect(page.getByRole('dialog')).toContainText('Edit cleaning')
  await choose(page.locator('#clean-cleaner'), 'lowercase')
  await expect(page.getByTestId('clean-column-form')).toContainText('smith, john', { timeout: 10_000 })
  await page.getByTestId('clean-submit').click()
  await expect.poll(() => cleanValues(api, sheetId), { timeout: 15_000 })
    .toEqual(['smith, john', 'jane doe', 'dr. mary o\'brien'])

  // An edit to the source reaches the clean column on its own (auto-run follows it).
  const edit = [{ rowIndex: 1, columnName: 'Name', value: 'BO' }]
  expect((await api.put(`/api/sheets/${sheetId}/data`, { data: { updates: edit } })).ok()).toBeTruthy()
  await expect.poll(() => cleanValues(api, sheetId), { timeout: 15_000 })
    .toEqual(['smith, john', 'bo', 'dr. mary o\'brien'])
  await expect(row(page, 1)).toContainText('bo', { timeout: 30_000 })

  // Auto-run off from the menu.
  await openMenu(page, 'Name (clean)')
  await page.getByRole('menuitem', { name: /Turn Off Auto-run/ }).click()
  await expect.poll(async () => (await getSheet(api, sheetId)).data.cleanColumns['Name (clean)'].autoRun,
    { timeout: 10_000 }).toBe(false)

  // Any column's menu opens Clean data with that column picked.
  await openMenu(page, 'val')
  await page.getByRole('menuitem', { name: 'Clean data…' }).click()
  await expect(page.getByTestId('clean-column-form').locator('#clean-source')).toHaveAttribute('data-value', 'val')
  await page.getByRole('button', { name: 'Cancel' }).click()
})

const PEOPLE = [
  { First: 'Dr. Sarah', Company: 'The Christman Company' },
  { First: 'MARY ANN', Company: 'Acme, Inc.' },
]
const previewAfter = (page: Page) => page.getByTestId('clean-preview').locator('tbody tr td:nth-child(2)')

test('Clean data options: what a name column holds, and "The ... Company"', async ({ page, context }) => {
  test.setTimeout(120_000)
  const api = await authedApi()
  const { tableId, sheetId } = await seedSheet(api, PEOPLE.length)
  for (const c of ['First', 'Company']) await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: c } })
  const updates = PEOPLE.flatMap((r, rowIndex) =>
    Object.entries(r).map(([columnName, value]) => ({ rowIndex, columnName, value })))
  expect((await api.put(`/api/sheets/${sheetId}/data`, { data: { updates } })).ok()).toBeTruthy()
  const view = async () => (await getSheet(api, sheetId)).data
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })

  const openClean = async () => {
    await page.getByRole('button', { name: /add new column/i }).click()
    await page.getByTestId('new-column-clean').click()
    return page.getByTestId('clean-column-form')
  }
  let form = await openClean()
  await choose(form.locator('#clean-source'), 'First')
  await choose(form.locator('#clean-cleaner'), 'first_name')
  const holds = form.getByTestId('clean-name-input')
  await expect(holds.getByRole('radio', { name: 'Full names' })).toBeChecked()
  await expect(form.getByTestId('clean-the-company')).toHaveCount(0)
  await expect(form.getByTestId('clean-phone-options')).toHaveCount(0)
  await expect(previewAfter(page)).toHaveText(['blank', 'Mary'], { timeout: 10_000 })
  await holds.getByRole('radio', { name: 'First names only' }).check()
  await expect(previewAfter(page)).toHaveText(['Sarah', 'Mary Ann'], { timeout: 10_000 })
  await choose(form.locator('#clean-cleaner'), 'last_name')
  await expect(holds.getByRole('radio', { name: 'Last names only' })).toBeVisible()
  await choose(form.locator('#clean-cleaner'), 'first_name')
  await page.getByTestId('clean-submit').click()
  await expect.poll(async () => (await view()).rows.map((r: any) => r.data['First (first name)'] ?? ''),
    { timeout: 15_000 }).toEqual(['Sarah', 'Mary Ann'])
  expect((await view()).cleanColumns['First (first name)'].options).toEqual({ nameInput: 'first_name' })

  // Edit cleaning shows the choice it was made with.
  await header(page, 'First (first name)').locator('.ag-header-cell-text').first().click()
  await page.getByRole('menuitem', { name: /Edit cleaning/ }).click()
  await expect(page.getByTestId('clean-name-input').getByRole('radio', { name: 'First names only' })).toBeChecked()
  await page.getByRole('button', { name: 'Cancel' }).click()

  form = await openClean()
  await choose(form.locator('#clean-source'), 'Company')
  await choose(form.locator('#clean-cleaner'), 'company_name')
  const the = form.getByTestId('clean-the-company')
  await expect(the.getByRole('radio', { name: /Drop/ })).toBeChecked()
  await expect(the).toContainText('Inc, LLC and other legal endings go either way')
  await expect(form.getByTestId('clean-name-input')).toHaveCount(0)
  await expect(previewAfter(page)).toHaveText(['Christman', 'Acme'], { timeout: 10_000 })
  await the.getByRole('radio', { name: /Keep/ }).check()
  await expect(previewAfter(page)).toHaveText(['The Christman Company', 'Acme'], { timeout: 10_000 })
  await page.getByTestId('clean-submit').click()
  await expect.poll(async () => (await view()).rows.map((r: any) => r.data['Company (clean)'] ?? ''),
    { timeout: 15_000 }).toEqual(['The Christman Company', 'Acme'])
  expect((await view()).cleanColumns['Company (clean)'].options).toEqual({ theCompany: 'keep' })
})
