import { test, expect } from '@playwright/test'
import { authedApi, BASE } from './helpers'

// Browser-driven smoke for the Access-tokens settings UI: section renders,
// create modal (scopes + secrets gating), show-once token view, list row,
// revoke. Screenshots land in E2E_SHOT_DIR (if set) for visual verification.

const SHOTS = process.env.E2E_SHOT_DIR || ''
const shot = (page: import('@playwright/test').Page, name: string) =>
  SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : Promise.resolve(Buffer.from(''))

test('settings UI: create → show-once → list → revoke', async ({ page, context }) => {
  const api = await authedApi()
  const cookies = await api.storageState()
  await context.addCookies(cookies.cookies)
  // Clean slate.
  const existing = await (await api.get('/api/settings/access-tokens')).json()
  for (const t of existing) await api.delete(`/api/settings/access-tokens/${t.id}`)

  // Tokens live on the Agent-access tab (settings is tabbed; /settings alone
  // redirects to /settings/ai). Deep-link straight to it.
  await page.goto(`${BASE}/settings/agents`)
  await expect(page.getByRole('heading', { name: 'Access tokens', exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('heading', { name: 'Connect an AI agent' })).toBeVisible()
  await expect(page.getByText('No access tokens yet')).toBeVisible()
  await shot(page, '1-settings-empty')

  // Open the create modal; secrets is disabled until 'run' is checked — it IS
  // checked by default, so uncheck run and verify secrets gets locked+cleared.
  await page.getByRole('button', { name: 'Create token' }).click()
  await expect(page.getByRole('heading', { name: 'Create access token' })).toBeVisible()
  const checkboxes = page.locator('input[type="checkbox"]')
  await expect(checkboxes).toHaveCount(4)
  const [, , runBox, secretsBox] = await checkboxes.all()
  await secretsBox.check()
  await expect(page.getByText('A leaked token with this scope')).toBeVisible()
  await runBox.uncheck()
  await expect(secretsBox).toBeDisabled()
  await expect(secretsBox).not.toBeChecked()
  await runBox.check()
  await page.getByPlaceholder('e.g., Claude MCP, enrichment-script').fill('UI smoke token')
  await shot(page, '2-create-modal')

  await page.getByRole('button', { name: 'Create token', exact: true }).last().click()
  await expect(page.getByRole('heading', { name: 'Access token created' })).toBeVisible()
  const tokenText = await page.locator('code').filter({ hasText: /^cubex_pat_[0-9a-f]{64}$/ }).textContent()
  expect(tokenText).toMatch(/^cubex_pat_[0-9a-f]{64}$/)
  await shot(page, '3-show-once')
  await page.getByRole('button', { name: 'Done' }).click()

  // List row: name, truncated prefix, scope badges; full token nowhere in the DOM.
  await expect(page.getByText('UI smoke token')).toBeVisible()
  await expect(page.locator('code').filter({ hasText: /^cubex_pat_[0-9a-f]{3}…$/ })).toBeVisible()
  expect(await page.content()).not.toContain(tokenText!)
  await shot(page, '4-list-row')

  // Revoke (it asks first) → back to empty state.
  await page.getByTitle('Revoke token (immediate: anything using it stops working)').click()
  await page.getByRole('button', { name: 'Revoke', exact: true }).click()
  await expect(page.getByText('No access tokens yet')).toBeVisible({ timeout: 10_000 })
  await shot(page, '5-after-revoke')
  await api.dispose()
})
