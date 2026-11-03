import { test, expect, type Page } from '@playwright/test'
import { authedApi, BASE } from './helpers'

// A tab left open across an update learns of it: every API answer names the app
// build the server serves (X-Cubex-Build, its entry script); once one names
// another build than the entry script the tab's page loaded, a notice offers
// Reload (never reloading on its own), once. The update is played by rewriting
// that header on the tab's API answers.
const NOTICE = 'Cubex was updated. Reload to use the new version.'

async function serveAnotherBuild(page: Page) {
  await page.route('**/api/**', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, headers: { ...response.headers(), 'x-cubex-build': 'index-NewBuild1' } })
  })
}

test('a tab open across an update says so once; Later puts it away; Reload loads the new app', async ({
  page, context,
}) => {
  test.setTimeout(60_000)
  const api = await authedApi()
  await context.addCookies((await api.storageState()).cookies)
  const health = await api.get(`${BASE}/api/health`)
  const served = health.headers()['x-cubex-build']
  expect(served).toMatch(/^index-[A-Za-z0-9_-]+$/)

  await page.goto(`${BASE}/settings/ai`)
  await expect(page.getByRole('heading', { name: 'Default AI model' })).toBeVisible()
  // The page loaded the build the server names: nothing to say.
  expect(await page.locator('script[type="module"][src*="/assets/index-"]').getAttribute('src'))
    .toBe(`/assets/${served}.js`)
  await expect(page.getByText(NOTICE)).toHaveCount(0)

  await serveAnotherBuild(page)
  await page.getByRole('link', { name: 'Enrichment', exact: true }).click()
  await expect(page.getByText(NOTICE)).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText(NOTICE)).toHaveCount(1)
  await page.getByRole('button', { name: 'Later' }).click()
  await expect(page.getByText(NOTICE)).toHaveCount(0)
  // More answers naming the new build: once the tab has handled them all, still no second notice.
  await page.getByRole('link', { name: 'Agent access' }).click()
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('heading', { name: 'Connect an AI agent' })).toBeVisible()
  await expect(page.getByText(NOTICE)).toHaveCount(0)

  // Reload loads the app the server serves: the page's build is the one every
  // answer names, so it has nothing to say.
  await page.unroute('**/api/**')
  await page.reload()
  await serveAnotherBuild(page)
  await page.getByRole('link', { name: 'Account' }).click()
  await expect(page.getByText(NOTICE)).toBeVisible({ timeout: 10_000 })
  await page.unroute('**/api/**')
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Reload' }).click()])
  await expect(page.getByRole('heading', { name: 'Change password' })).toBeVisible()
  const after = page.waitForResponse(r => r.url().includes('/api/'))
  await page.getByRole('link', { name: 'Enrichment', exact: true }).click()
  await after
  await expect(page.getByRole('heading', { name: 'treg API key' })).toBeVisible()
  await expect(page.getByText(NOTICE)).toHaveCount(0)
})
