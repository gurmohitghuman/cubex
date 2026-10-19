import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import { authedApi, getSheet, BASE } from './helpers'
import { seedLookupSheets } from './helpers-lookup'
import { choose } from './helpers-ui'

// The app's Lookup flow: "+ Add Column" offers Lookup; the sheet to look in
// is picked from another table, then the columns; the preview shows the first
// matches; the new column gets its icon and values; contains says it can take
// minutes; its menu looks every row up again and opens Edit lookup; a column
// the lookup reads deleted in the other sheet shows why it stopped.
// Screenshots go to test-results/lookup/ (E2E_SHOTS overrides).

const SHOTS = process.env.E2E_SHOTS ?? 'test-results/lookup'
const header = (page: Page, name: string) => page.locator('.ag-header-cell').filter({ hasText: name }).first()
async function openMenu(page: Page, name: string) {
  await header(page, name).locator('.ag-header-cell-text').first().click()
  await expect(page.getByRole('menu')).toBeVisible()
}
const row = (page: Page, i: number) => page.locator(`.ag-center-cols-container .ag-row[row-index="${i}"]`)
const values = async (api: APIRequestContext, sheetId: string, column: string) =>
  (await getSheet(api, sheetId)).data.rows.map((r: any) => r.data[column] ?? '')

test('Lookup from the Add Column dialog and the column menu', async ({ page, context }) => {
  test.setTimeout(120_000)
  const api = await authedApi()
  const s = await seedLookupSheets(api)
  await context.addCookies((await api.storageState()).cookies)
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto(`${BASE}/table/${s.leadsTable}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: /add new column/i }).click()
  await page.getByTestId('new-column-lookup').click()
  const form = page.getByTestId('lookup-column-form')
  await expect(form).toBeVisible()
  // The sheets of every other table are offered, grouped by table.
  await choose(form.getByTestId('lookup-sheet'), { label: 'Companies' })
  await choose(form.getByTestId('lookup-match-column'), 'Website')
  await choose(form.getByTestId('lookup-source'), 'Domain')
  await choose(form.getByTestId('lookup-return-column'), 'Industry')
  await expect(form.getByTestId('lookup-name')).toHaveAttribute('placeholder', 'Industry (Companies)')
  await expect(page.getByTestId('lookup-preview')).toContainText('Robots', { timeout: 10_000 })
  await expect(page.getByTestId('lookup-preview')).toContainText('Energy')
  await expect(page.getByTestId('lookup-autorun')).toBeChecked()
  await page.screenshot({ path: `${SHOTS}/1-lookup-dialog.png` })
  // Contains says it can take minutes on very large sheets.
  await choose(form.getByTestId('lookup-match'), 'contains')
  await expect(form).toContainText('can take a few minutes')
  await choose(form.getByTestId('lookup-match'), 'equals')
  await page.getByTestId('lookup-submit').click()

  await expect(header(page, 'Industry (Companies)')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('lookup-icon')).toHaveCount(1)
  await expect(row(page, 0)).toContainText('Robots', { timeout: 15_000 })
  expect(await values(api, s.leadsId, 'Industry (Companies)')).toEqual(['Robots', 'Energy', ''])
  await page.getByTestId('lookup-icon').hover()
  await expect(page.getByTestId('header-tip')).toContainText('Looks up Domain in Companies › Website')
  await page.screenshot({ path: `${SHOTS}/2-lookup-column.png` })

  // The other sheet changes; the column doesn't, until "Look up every row again".
  const companies = await getSheet(api, s.companiesId)
  expect(companies.data.rows[0].data.Website).toBe('acme.com')
  await api.put(`/api/sheets/${s.companiesId}/data`,
    { data: { updates: [{ rowIndex: 0, columnName: 'Industry', value: 'Robotics' }] } })
  await page.waitForTimeout(1500)
  expect((await values(api, s.leadsId, 'Industry (Companies)'))[0]).toBe('Robots')
  await openMenu(page, 'Industry (Companies)')
  await expect(page.getByRole('menuitem', { name: /look up every row again/i })).toBeVisible()
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOTS}/3-lookup-menu.png` })
  await page.getByRole('menuitem', { name: /look up every row again/i }).click()
  await expect.poll(async () => (await values(api, s.leadsId, 'Industry (Companies)'))[0], { timeout: 15_000 })
    .toBe('Robotics')

  // A column it reads deleted in the other sheet: the header says why, and Edit lookup shows it.
  expect((await api.delete(`/api/sheets/${s.companiesId}/columns/Industry`)).ok()).toBeTruthy()
  await page.reload()
  await expect(page.getByTestId('lookup-icon')).toHaveCount(1, { timeout: 15_000 })
  await openMenu(page, 'Industry (Companies)')
  await page.getByRole('menuitem', { name: /edit lookup/i }).click()
  await expect(page.getByTestId('lookup-status')).toContainText('"Industry" in "Companies" was deleted')
  // The deleted column shows as such (not as the first column there), and saving waits for another.
  await expect(page.getByTestId('lookup-return-column')).toHaveText('Industry (deleted)')
  await expect(page.getByTestId('lookup-missing')).toBeVisible()
  await expect(page.getByTestId('lookup-submit')).toBeDisabled()
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOTS}/4-lookup-broken.png` })
})
