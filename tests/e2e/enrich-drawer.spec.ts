import { test, expect, Page } from '@playwright/test'
import { authedApi, BASE } from './helpers'
import { mockTreg, seedLeads, setTregKey } from './helpers-treg'

// The Add enrichment drawer against the mock treg's catalog: the Enrichment
// button, Find (Popular jobs, search groups, no results), Set up (inputs
// matched by column name, Run disabled with its reason), and with a key saved:
// no banner, the team's own and free providers pinned on top, the balance, and
// the amber box when the run could cost more than the balance.

const drawer = (page: Page) => page.getByTestId('enrich-drawer')

async function openDrawer(page: Page) {
  await page.getByRole('button', { name: 'Enrichment', exact: true }).click()
  await expect(page.getByText('Add enrichment')).toBeVisible()
}

test('Enrichment drawer: button, Find, search, Set up, Run disabled until a key is saved', async ({ page, context }) => {
  const api = await authedApi()
  await mockTreg.reset()
  await setTregKey(api, null)
  const { tableId } = await seedLeads(api)
  await context.addCookies((await api.storageState()).cookies)

  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  const button = page.getByRole('button', { name: 'Enrichment', exact: true })
  await expect(button).toBeEnabled()
  // It sits right after AI Column, the one filled button.
  const order = await page.locator('header button').allInnerTexts()
  expect(order.map(t => t.trim()).indexOf('Enrichment')).toBe(order.map(t => t.trim()).indexOf('AI Column') + 1)

  // Find: the Popular jobs, and the banner while no key is saved.
  await openDrawer(page)
  await expect(page.getByText('Pick what you want to find')).toBeVisible()
  await expect(drawer(page).getByTestId('treg-notice')).toBeVisible()
  await expect(drawer(page).getByTestId('enrich-tool-card')).toHaveCount(8)

  // Search: waterfalls first, then single providers; nothing for nonsense.
  const search = drawer(page).getByLabel('Search enrichments')
  await search.fill('phone')
  await expect(drawer(page).getByText('Waterfalls (tries providers for you)')).toBeVisible()
  await expect(drawer(page).getByText('Single providers')).toBeVisible()
  await search.fill('zzqxv nothing')
  await expect(drawer(page).getByText(/Nothing found for "zzqxv nothing"/)).toBeVisible()
  await search.fill('')

  // Set up: inputs matched by column name, Run waits for a key.
  await drawer(page).getByTestId('enrich-tool-card').filter({ hasText: 'Verified work email' }).click()
  await expect(page.getByText('Set up Verified work email')).toBeVisible()
  await expect(drawer(page).getByLabel('Full name', { exact: true })).toHaveValue('c:Name')
  await expect(drawer(page).getByLabel('Company domain', { exact: true })).toHaveValue('c:Website')
  const reason = drawer(page).getByTestId('enrich-run-reason')
  const runSome = drawer(page).getByRole('button', { name: /^Run on/ })
  const runAll = drawer(page).getByRole('button', { name: /^Run all/ })
  await expect(reason).toHaveText('Add your treg key in Settings first.')
  await expect(runSome).toBeDisabled()
  await expect(runAll).toBeDisabled()
  await expect(runAll).toHaveText('Run all 3')

  // Unmap the name: the reason says what's missing.
  await drawer(page).getByLabel('Full name', { exact: true }).selectOption('')
  await expect(reason).toContainText('Pick columns for')
  await drawer(page).getByLabel('Full name', { exact: true }).selectOption('c:Name')
  await expect(reason).toHaveText('Add your treg key in Settings first.')

  // With a key, a Hunter key and a free source at treg, and a small balance.
  // Its own key: the server caches access per key (helpers-treg.ts).
  await setTregKey(api, 'treg_mock_drawer_spec')
  await mockTreg.set({ ownKeys: ['hunter'], freeProviders: ['contactout'], balanceMicro: 50_000 })
  await page.keyboard.press('Escape')
  await expect(page.getByText('Add enrichment')).toHaveCount(0)
  await openDrawer(page)
  await expect(page.getByText('Set up Verified work email')).toBeVisible()
  await expect(drawer(page).getByTestId('treg-notice')).toHaveCount(0)

  await drawer(page).getByRole('button', { name: /^Providers/ }).click()
  const pinned = drawer(page).getByTestId('enrich-providers').locator('section').first()
  await expect(pinned.getByText('Always first: your keys and free sources')).toBeVisible()
  await expect(pinned.getByTestId('enrich-provider').filter({ hasText: 'Hunter' })).toContainText('your key')
  await expect(pinned.getByTestId('enrich-provider').filter({ hasText: 'ContactOut' })).toContainText('free')

  // The estimate: the balance, and amber when the run could pass it.
  const estimate = drawer(page).getByTestId('enrich-estimate')
  await expect(estimate).toContainText('Estimated for 3 rows')
  await expect(estimate).toContainText('This could cost more than your treg balance ($0.05)')
  await expect(estimate).toHaveClass(/bg-amber-50/)
  await expect(drawer(page).getByTestId('enrich-daily-line')).toContainText('Daily limit $10.00')
  await expect(reason).toHaveText('Try it on a few rows first, then run the rest.')
  await expect(runSome).toBeEnabled()

  // The waterfall's access was completed: Hunter needs a name and a domain, so
  // treg's own plan for the tool left it out and Cubex asked about it alone.
  const seen = await mockTreg.requests()
  expect(seen.some(r => r.path === '/catalog/endpoints/treg.people.email.find/access')).toBe(true)
  expect(seen.some(r => r.path === '/catalog/endpoints/hunter.people.email.find/access')).toBe(true)
  await api.dispose()
})
