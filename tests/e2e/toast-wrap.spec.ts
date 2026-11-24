import { test, expect } from '@playwright/test'
import { BASE, authedApi } from './helpers'

// A toast that quotes a long word with no spaces (a saved key's 200-character name) breaks it inside its box
// instead of running past it: the saved-key form's refusal, at desktop and phone width.
const LONG = 'k'.repeat(200)
for (const size of [{ name: 'desktop', width: 1280, height: 800 }, { name: 'phone', width: 390, height: 844 }]) {
  test(`a toast with a 200-character word stays in its box (${size.name})`, async ({ page, context }) => {
    await page.setViewportSize({ width: size.width, height: size.height })
    const api = await authedApi()
    await context.addCookies((await api.storageState()).cookies)
    await page.route('**/api/settings/api-keys', route => (route.request().method() === 'POST'
      ? route.fulfill({ status: 409, contentType: 'application/json',
        body: JSON.stringify({ error: `A saved key named "${LONG}" already exists. Use it, or choose another name.` }) })
      : route.continue()))
    await page.goto(`${BASE}/settings/http-enrichment`)
    await page.getByRole('button', { name: /Add (first )?key/ }).first().click()
    await page.getByPlaceholder('e.g., openai_key, stripe_secret').fill('duplicate_key')
    await page.getByPlaceholder('Enter your API key').fill('secret-value')
    await page.getByRole('button', { name: 'Create Key' }).click()
    const toast = page.locator('[role="status"]').filter({ hasText: 'already exists' })
    await expect(toast).toBeVisible()
    const fits = await toast.evaluate(el => {
      const box = (el.closest('[class*="go"]') ?? el).getBoundingClientRect()
      return { right: box.right, width: window.innerWidth, overflow: el.scrollWidth - el.clientWidth }
    })
    expect(fits.right).toBeLessThanOrEqual(fits.width)
    expect(fits.overflow).toBeLessThanOrEqual(1)
  })
}
