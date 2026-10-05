import { test, expect } from '@playwright/test'
import { authedApi, BASE } from './helpers'

// Settings redesign smoke: route-backed tabs render, /settings redirects to
// the AI tab, unknown slugs fall back, and each tab shows its own content.
// Screenshots land in E2E_SHOT_DIR (if set) for visual verification.

const SHOTS = process.env.E2E_SHOT_DIR || ''
const shot = (page: import('@playwright/test').Page, name: string) =>
  SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : Promise.resolve(Buffer.from(''))

test('settings tabs: redirect, per-tab content, navigation', async ({ page, context }) => {
  const api = await authedApi()
  await context.addCookies((await api.storageState()).cookies)

  // /settings (and junk slugs) land on the AI tab.
  await page.goto(`${BASE}/settings`)
  await expect(page).toHaveURL(/\/settings\/ai$/)
  await expect(page.getByRole('heading', { name: 'OpenRouter API Key' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('heading', { name: 'Default AI model' })).toBeVisible()
  // The tab row never overflows vertically: a 1px overhang drew a scrollbar
  // on Macs that always show scrollbars.
  const tabRow = page.getByRole('navigation', { name: 'Settings sections' })
  expect(await tabRow.evaluate(el => el.scrollHeight - el.clientHeight)).toBe(0)
  await shot(page, 'tab-1-ai')
  await page.goto(`${BASE}/settings/nonsense`)
  await expect(page).toHaveURL(/\/settings\/ai$/)

  // HTTP Enrichment: renamed keys section, no access-tokens content here.
  await page.getByRole('link', { name: 'HTTP Enrichment' }).click()
  await expect(page).toHaveURL(/\/settings\/http-enrichment$/)
  await expect(page.getByRole('heading', { name: 'External service keys' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Access tokens' })).toHaveCount(0)
  await shot(page, 'tab-2-http')

  // Agent access: MCP connect card (endpoint + Claude command) + tokens.
  await page.getByRole('link', { name: 'Agent access' }).click()
  await expect(page).toHaveURL(/\/settings\/agents$/)
  await expect(page.getByRole('heading', { name: 'Connect an AI agent' })).toBeVisible()
  await expect(page.getByText(/claude mcp add --scope user --transport http cubex/)).toBeVisible()
  await expect(page.getByText(/codex mcp add cubex --url/)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Access tokens', exact: true })).toBeVisible()
  await shot(page, 'tab-3-agents')

  // Account: change password + sign out.
  await page.getByRole('link', { name: 'Account' }).click()
  await expect(page).toHaveURL(/\/settings\/account$/)
  await expect(page.getByRole('heading', { name: 'Change password' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
  await shot(page, 'tab-4-account')

  // Browser back walks the tab history (route-backed, not local state).
  await page.goBack()
  await expect(page).toHaveURL(/\/settings\/agents$/)

  await api.dispose()
})
