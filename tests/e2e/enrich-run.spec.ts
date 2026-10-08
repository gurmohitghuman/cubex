import { test, expect, Page } from '@playwright/test'
import { authedApi, BASE } from './helpers'
import { expectBilledOnce, freshTreg, rowsOf, runIdsOf, seedLeadRows } from './helpers-enrich'

// The drawer runs an enrichment (plan Verification #2): Run on 5 rows makes a
// real run on the first rows and shows them in the Test step with their cost
// and an estimate for the rows not enriched yet; Back to setup keeps the
// column, whose full run asks first, quoting the rows it takes; Run on N more
// rows from the Test step adds to the same column and shows the Run step.

const drawer = (page: Page) => page.getByTestId('enrich-drawer')
const NAMES = ['Maya Chen', 'Leo Martins', 'Ava Patel', 'Noah Kim', 'Iris Novak', 'Omar Haddad', 'Lena Vogel',
  'Ravi Shah', 'Zoe Park', 'Ian Ross', 'Eve Lin', 'Max Roy']
const valid = async (api: Awaited<ReturnType<typeof authedApi>>, sheetId: string) =>
  (await rowsOf(api, sheetId)).filter(r => r['Verified work email'] === '✅ Valid').length
const testDone = (page: Page) => expect(page.getByTestId('enrich-test-status')).toHaveText(/^Done/, { timeout: 30_000 })

test('Run on 5 rows, check them, then the rest', async ({ page, context }) => {
  test.setTimeout(120_000)
  const api = await authedApi()
  await freshTreg(api)
  const leads = NAMES.map((Name, i) => ({ Name, Website: `https://www.co${i}.example/team` }))
  const { tableId, sheetId } = await seedLeadRows(api, leads)
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: 'Enrichment', exact: true }).click()
  await drawer(page).getByTestId('enrich-tool-card').filter({ hasText: 'Verified work email' }).click()
  await expect(drawer(page).getByTestId('enrich-run-reason'))
    .toHaveText('Try it on a few rows first, then run the rest.', { timeout: 15_000 })
  await drawer(page).getByTestId('enrich-run-test').click()

  // The Test step: the 5 rows as the grid shows them, each with its cost.
  await expect(page.getByText('Check the first 5 rows')).toBeVisible()
  await testDone(page)
  await expect(page.getByTestId('enrich-result-row')).toHaveCount(5)
  await expect(page.getByTestId('enrich-result-row').first()).toContainText('Row 1 · Maya Chen')
  await expect(page.getByTestId('enrich-result-row').first()).toContainText('✅ Valid')
  await expect(page.getByTestId('enrich-row-cost')).toHaveCount(5)
  expect(await valid(api, sheetId)).toBe(5)
  // The estimate and the button count only the rows not enriched yet.
  await expect(drawer(page).getByTestId('enrich-estimate'))
    .toContainText('Estimated for the other 7 rows', { timeout: 15_000 })
  await expect(drawer(page).getByTestId('enrich-run-more')).toHaveText('Run on 7 more rows')

  // Back to setup: the column stays, its rows are counted by status, and the
  // full run's confirm quotes the rows not enriched yet (not all 12).
  await drawer(page).getByTestId('enrich-back-setup').click()
  await expect(page.getByText('Edit enrichment', { exact: true })).toBeVisible()
  await expect(drawer(page).getByTestId('enrich-rows-status'))
    .toContainText('Rows not enriched yet (7)', { timeout: 15_000 })
  await expect(drawer(page).getByTestId('enrich-run-all')).toHaveText('Run on 7 rows', { timeout: 15_000 })
  await drawer(page).getByTestId('enrich-run-all').click()
  const dialog = page.getByRole('dialog').filter({ hasText: 'Run the enrichment' })
  await expect(dialog).toContainText('on 7 rows not enriched yet')
  await expect(dialog).toContainText(/Estimated \$[\d.]+ to \$[\d.]+/)
  await expect(dialog).toContainText("Today's limit: $10.00")
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  // Test the next rows, then run the rest from the Test step.
  await drawer(page).getByTestId('enrich-run-test').click()
  await testDone(page)
  await expect(page.getByTestId('enrich-result-row').first()).toContainText('Row 6')
  await expect(drawer(page).getByTestId('enrich-run-more')).toHaveText('Run on 2 more rows', { timeout: 15_000 })
  await drawer(page).getByTestId('enrich-run-more').click()
  // It asks first too, quoting the rows and where the run stops.
  const more = page.getByRole('dialog').filter({ hasText: 'Run the enrichment' })
  await expect(more).toContainText('on 2 rows not enriched yet')
  await expect(more).toContainText(/The run stops at \$[\d.]+/)
  await more.getByRole('button', { name: 'Run', exact: true }).click()

  // The Run step: progress, spent of the limit, the latest rows; then done.
  await expect(page.getByTestId('enrich-run-step')).toBeVisible()
  await expect(page.getByTestId('enrich-view-results')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('enrich-run-progress')).toHaveText('2 of 2')
  await expect(page.getByTestId('enrich-run-spent')).toContainText(/Spent: \$[\d.]+ of \$[\d.]+/)
  await page.getByTestId('enrich-view-results').click()
  await expect(drawer(page)).toHaveCount(0)
  expect(await valid(api, sheetId)).toBe(12)
  const runs = runIdsOf(sheetId)
  expect(runs).toHaveLength(3)
  await expectBilledOnce(runs)

  // The next open starts over at Find.
  await page.getByRole('button', { name: 'Enrichment', exact: true }).click()
  await expect(page.getByText('Pick what you want to find')).toBeVisible()
  await api.dispose()
})
