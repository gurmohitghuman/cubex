import { test, expect } from '@playwright/test'
import { authedApi, getSheet, BASE } from './helpers'
import { EMAILS_LEFT, LEADS, seedLeads } from './helpers-dedupe'
import { choose, openDataMenu } from './helpers-ui'

// The app's Remove duplicates dialog: it opens on the Email column matched as
// an email, shows what would go (counts and groups) and changes with the
// choices; removing reloads the grid without the duplicates.

test('Remove duplicates from the toolbar', async ({ page, context }) => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const { tableId, sheetId } = await seedLeads(api)
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(`${LEADS.length} rows`)).toBeVisible()

  await openDataMenu(page, 'Remove duplicates')
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('Column to match on')).toHaveAttribute('data-value', 'Email')
  await expect(dialog.getByLabel('How Email matches')).toHaveAttribute('data-value', 'email')
  const summary = page.getByTestId('dedupe-summary')
  await expect(summary).toHaveText('3 duplicate rows in 2 groups. 6 rows stay.', { timeout: 15_000 })
  await expect(page.getByTestId('dedupe-check')).toContainText('4 rows missing a value to match on')
  const samples = page.getByTestId('dedupe-samples')
  await expect(samples).toContainText('Row 1 stays')
  await expect(samples).toContainText('Rows 2, 6')
  await expect(samples).toContainText('JO@Acme.com') // the removed row as it was written

  // Last row: row 6 stays.
  await dialog.getByLabel('Last row').check()
  await expect(samples).toContainText('Row 6 stays', { timeout: 15_000 })
  // Website as a domain: two groups of two.
  await choose(dialog.getByLabel('Column to match on'), 'Website')
  await expect(dialog.getByLabel('How Website matches')).toHaveAttribute('data-value', 'domain')
  await expect(summary).toHaveText('2 duplicate rows in 2 groups. 7 rows stay.', { timeout: 15_000 })

  // Back to email, first row, and remove.
  await choose(dialog.getByLabel('Column to match on'), 'Email')
  await dialog.getByLabel('First row').check()
  await expect(summary).toHaveText('3 duplicate rows in 2 groups. 6 rows stay.', { timeout: 15_000 })
  await page.getByTestId('dedupe-remove').click()
  await expect(page.getByText('Removed 3 duplicate rows')).toBeVisible({ timeout: 15_000 })
  await expect(dialog).toBeHidden()
  await expect(page.getByText('6 rows', { exact: false }).first()).toBeVisible()
  const emails = (await getSheet(api, sheetId)).data.rows.map((r: any) => r.data.Email ?? '')
  expect(emails).toEqual(EMAILS_LEFT)
})
