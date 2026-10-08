import { test, expect, Page } from '@playwright/test'
import { authedApi, BASE } from './helpers'
import { expectBilledOnce, freshTreg, rowsOf, runIdsOf, seedLeadRows } from './helpers-enrich'

// The drawer runs an enrichment (plan Verification #2): Run on 5 rows makes a
// real run on the first rows and closes the drawer while the grid fills, then
// Run the rest asks first, repeating the estimate, and adds to the same column.

const drawer = (page: Page) => page.getByTestId('enrich-drawer')
const NAMES = ['Maya Chen', 'Leo Martins', 'Ava Patel', 'Noah Kim', 'Iris Novak', 'Omar Haddad', 'Lena Vogel', 'Ravi Shah']
const valid = async (api: Awaited<ReturnType<typeof authedApi>>, sheetId: string) =>
  (await rowsOf(api, sheetId)).filter(r => r['Verified work email'] === '✅ Valid').length

async function openSetup(page: Page) {
  await page.getByRole('button', { name: 'Enrichment', exact: true }).click()
  await expect(page.getByText('Add enrichment')).toBeVisible()
}

test('Run on 5 rows, then the rest', async ({ page, context }) => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await freshTreg(api)
  const { tableId, sheetId } = await seedLeadRows(api, NAMES.map((Name, i) => ({ Name, Website: `https://www.co${i}.example/team` })))
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })

  await openSetup(page)
  await drawer(page).getByTestId('enrich-tool-card').filter({ hasText: 'Verified work email' }).click()
  await expect(page.getByText('Set up Verified work email')).toBeVisible()
  await expect(drawer(page).getByTestId('enrich-run-reason')).toHaveText('Try it on a few rows first, then run the rest.', { timeout: 15_000 })
  await drawer(page).getByTestId('enrich-run-test').click()
  await expect(page.getByText('Add enrichment')).toHaveCount(0)
  await expect.poll(() => valid(api, sheetId), { timeout: 30_000 }).toBe(5)
  await expect(page.locator('.ag-cell').filter({ hasText: '✅ Valid' }).first()).toBeVisible({ timeout: 15_000 })
  const firstRows = await rowsOf(api, sheetId)
  expect(firstRows[0]['Work email']).toBe('maya.chen@co0.example')
  expect(firstRows[0]['Found by']).toBe('Pattern guess')
  expect(firstRows[7]['Verified work email'] ?? '').toBe('')

  // The draft kept its column: the next run adds to it, after a confirm.
  await openSetup(page)
  const rest = drawer(page).getByTestId('enrich-run-all')
  await expect(rest).toHaveText('Run the rest')
  await expect(rest).toBeEnabled({ timeout: 15_000 })
  await rest.click()
  const dialog = page.getByRole('dialog').filter({ hasText: 'Run the enrichment' })
  await expect(dialog).toContainText('rows not enriched yet')
  await expect(dialog).toContainText(/Estimated \$[\d.]+ to \$[\d.]+/)
  await expect(dialog).toContainText("Today's limit: $10.00")
  await dialog.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.getByText('Add enrichment')).toHaveCount(0)
  await expect.poll(() => valid(api, sheetId), { timeout: 30_000 }).toBe(8)
  const runs = runIdsOf(sheetId)
  expect(runs).toHaveLength(2)
  await expectBilledOnce(runs)
  await api.dispose()
})
