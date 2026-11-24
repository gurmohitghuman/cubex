import { test, expect, type Page } from '@playwright/test'
import { authedApi } from './helpers'
import { freshTreg, seedCsv } from './helpers-enrich'
import { openColumnType } from './helpers-ui'
import { CSV, openTable, watchInput, watchReads } from './helpers-reads'

// A click, a pick or a toggle reads at once; only typing waits for a pause (client/src/lib/typingWait.ts). In the
// drawers, a switch changes what the estimate reads: its read goes with the click, not 200 ms after it.

// The next read of `reads` after `act`, ms after the click.
async function readAfterClick(page: Page, reads: { reads: Array<{ start: number }> }, act: () => Promise<void>) {
  const input = await watchInput(page)
  const before = reads.reads.length
  await act()
  await expect.poll(() => reads.reads.length).toBeGreaterThan(before)
  return reads.reads[before].start - (await input()).click
}

test('Enrichment drawer: a provider switch and Stop after the first provider read the estimate at once', async ({
  page, context,
}) => {
  test.setTimeout(60_000)
  const api = await authedApi()
  await freshTreg(api)
  const { tableId } = await seedCsv(api, CSV)
  await openTable(page, context, tableId)
  const estimates = await watchReads(page, /\/enrich\/estimate$/, 0)
  await openColumnType(page, 'Enrichment')
  const drawer = page.getByTestId('enrich-drawer')
  await drawer.getByTestId('enrich-tool-card').filter({ hasText: /^Verified work email/ }).click()
  await expect(drawer.getByTestId('enrich-estimate')).toContainText('$', { timeout: 15_000 })
  await drawer.getByText('Providers', { exact: true }).click()
  const stop = drawer.getByRole('checkbox', { name: /Stop after the first provider/ })
  expect(await readAfterClick(page, estimates, () => stop.click()), 'stop at first: at once').toBeLessThan(150)
  await expect.poll(() => estimates.reads.at(-1)?.end ?? null).not.toBeNull()
  const provider = drawer.getByTestId('enrich-provider').locator('[role=switch]:not([disabled])').first()
  expect(await readAfterClick(page, estimates, () => provider.click()), 'a provider switch: at once')
    .toBeLessThan(150)
})

test('Waterfall drawer: a step switched off reads the estimate at once', async ({ page, context }) => {
  test.setTimeout(60_000)
  const api = await authedApi()
  await freshTreg(api)
  const { tableId } = await seedCsv(api, CSV)
  await openTable(page, context, tableId)
  const estimates = await watchReads(page, /\/waterfall\/sheets\/[^/]+\/estimate$/, 0)
  await openColumnType(page, 'Waterfall')
  const drawer = page.getByTestId('waterfall-drawer')
  await drawer.getByTestId('waterfall-template-work_email').click()
  await expect(drawer.getByTestId('waterfall-estimate')).toContainText('a row on average', { timeout: 15_000 })
  await expect.poll(() => estimates.reads.at(-1)?.end ?? null).not.toBeNull()
  const step = drawer.getByRole('switch', { name: 'Use step 1' })
  expect(await readAfterClick(page, estimates, () => step.click()), 'a step switch: at once').toBeLessThan(150)
})
