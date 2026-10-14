import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import { authedApi, seedSheet, getSheet, BASE } from './helpers'

// The app's Clean data flow: "+ Add Column" offers Clean data, the preview
// shows before and after, the new column gets its icon and values, its menu
// edits it and switches auto-run, every column's menu opens Clean data on it,
// and an edit to the source reaches the clean column on its own.

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
  await form.locator('#clean-source').selectOption('Name')
  await form.locator('#clean-cleaner').selectOption('person_name')
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
  await page.locator('#clean-cleaner').selectOption('lowercase')
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
  await expect(page.getByTestId('clean-column-form').locator('#clean-source')).toHaveValue('val')
  await page.getByRole('button', { name: 'Cancel' }).click()
})
