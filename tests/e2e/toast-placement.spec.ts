import { test, expect } from '@playwright/test'
import { authedApi, BASE } from './helpers'

// Where toasts show on a page without the sheet's top bar: Settings keeps them 16px from the top, above its tabs.
// 64px down, where the sheet and the dashboard put them (below their bar), a toast lay over the Settings tabs, and
// a hovered toast stays. The sheet's own case is in sheet-paused-http.spec.ts.
test('Settings: a toast shows above the tabs, clear of them', async ({ page, context }) => {
  const api = await authedApi()
  await context.addCookies((await api.storageState()).cookies)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`${BASE}/settings/agents`)
  await page.getByTitle('Copy endpoint').click()
  const shown = page.locator('[data-rht-toaster] [role="status"]').filter({ hasText: 'Endpoint copied' })
  await shown.hover()
  const tabs = page.getByRole('navigation', { name: 'Settings sections' })
  // The toast's bar (its message sits inside it).
  const [t, n] = [await shown.locator('xpath=..').boundingBox(), await tabs.boundingBox()]
  expect(t!.y + t!.height, 'the toast ends above the tabs').toBeLessThanOrEqual(n!.y)
})
