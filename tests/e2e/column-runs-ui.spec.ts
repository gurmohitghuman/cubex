import { test, expect, type Page } from '@playwright/test'
import { authedApi, makeAccessToken, BASE } from './helpers'
import { mcpClient } from './helpers-mcp'
import { Receiver } from './helpers-receiver'
import { column } from './helpers-setups'
import { short, twoColumns } from './helpers-column-runs'

// The app's Data → Run columns (components/column-runs/): every run column ticked, on its empty or out-of-date
// rows. With every row done there's nothing to run (Start off, and it says so); "All rows" prices each column's
// 3 rows and starts both. The header's chip follows it as a run, and its columns fill again. With a filter on
// the sheet, "Only rows in the current filter" starts ticked and keeps the price to the rows it shows.
const rx = new Receiver()
test.beforeAll(() => rx.start())
test.afterAll(() => rx.stop())

const openDialog = async (page: Page) => {
  await page.getByTestId('data-menu').click()
  await page.getByTestId('run-columns').click()
  await expect(page.getByTestId('run-columns-form')).toBeVisible()
}

test('Data → Run columns: ticked, priced, started; the chip follows it; a filter keeps it to its rows', async ({
  page, context,
}) => {
  test.setTimeout(180_000)
  const api = await authedApi()
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'column-runs-ui'))
  const { tableId, sheetId } = await twoColumns(rx, client, api)
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-header-cell').filter({ hasText: 'Echo ok' }).first()).toBeVisible({ timeout: 15_000 })

  await openDialog(page)
  const form = page.getByTestId('run-columns-form')
  await expect(form.getByTestId('run-columns-option')).toHaveCount(2)
  await expect(form.getByRole('checkbox', { name: 'Lookup' })).toBeChecked()
  await expect(form.getByRole('checkbox', { name: 'Echo' })).toBeChecked()
  await expect(form.getByRole('radio', { name: 'Empty or out of date' })).toBeChecked()
  await expect(page.getByText('No row needs running.')).toBeVisible()
  const start = page.getByTestId('run-columns-start')
  await expect(start).toBeDisabled()

  await form.getByRole('radio', { name: 'All rows' }).check()
  const rows = page.getByTestId('column-run-estimate-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('1.Lookup')
  await expect(rows.nth(0)).toContainText('3 requests')
  await expect(rows.nth(1)).toContainText('2.Echo')
  await expect(start).toHaveText('Run 2 columns')
  await form.getByRole('checkbox', { name: 'Echo' }).uncheck()
  await expect(start).toHaveText('Run 1 column')
  await form.getByRole('checkbox', { name: 'Echo' }).check()
  await expect(start).toBeEnabled()

  short(rx, '2')
  await start.click()
  await expect(form).toBeHidden()
  const chip = page.getByTestId('setup-run-chip')
  await expect(chip).toContainText('Run columns: Lookup, Echo')
  await expect(chip.getByRole('button', { name: 'Pause the run' })).toBeVisible()
  await expect(page.getByText('"Run columns: Lookup, Echo" is done.')).toBeVisible({ timeout: 60_000 })
  expect(await column(api, sheetId, 'Label')).toEqual(['one2!', 'two2!', 'three2!'])

  // A filter on the sheet: the dialog offers its rows, ticked, and prices only them.
  expect((await api.put(`/api/sheets/${sheetId}/column-filters`, { data: { columnFilters: {
    Website: { type: 'contains', value: 'two' } } } })).ok()).toBeTruthy()
  await page.reload()
  await expect(page.locator('.ag-header-cell').filter({ hasText: 'Echo ok' }).first()).toBeVisible({ timeout: 15_000 })
  await openDialog(page)
  const inFilter = page.getByTestId('run-columns-in-filter')
  await expect(inFilter).toBeChecked()
  await expect(form).toContainText('"Website" contains "two"')
  await form.getByRole('radio', { name: 'All rows' }).check()
  await expect(rows.nth(0)).toContainText('1 request')
  await inFilter.uncheck()
  await expect(rows.nth(0)).toContainText('3 requests')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(form).toBeHidden()
  await api.put(`/api/sheets/${sheetId}/column-filters`, { data: { columnFilters: null } })
})
