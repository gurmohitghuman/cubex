import { test, expect } from '@playwright/test'
import { authedApi, BASE } from './helpers'
import { MOCK_TEAM_KEY, mockTreg, setTregKey } from './helpers-treg'

// Settings → Enrichment, against the mock treg: refusals in plain words, save
// and test a team key (balance, holds, team), treg unreachable, and clear. The
// key only ever leaves the server in X-Treg-Token, and never comes back.

test('treg key: save, test and remove', async ({ page, context }) => {
  const api = await authedApi()
  await mockTreg.reset()
  await setTregKey(api, null)
  await context.addCookies((await api.storageState()).cookies)

  await page.goto(`${BASE}/settings/http-enrichment`)
  const card = page.getByTestId('treg-card')
  await expect(card.getByText('No key configured', { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(card.getByText('treg key required')).toBeVisible()
  // Its label reads "Update treg key" once a key is saved.
  const field = card.locator('#tregKey')
  await expect(card.getByLabel('Enter treg key')).toBeVisible()
  const result = card.getByTestId('treg-test-result')

  // A key treg refuses, then a personal login token: tested, never saved.
  await field.fill('treg_wrong_key_123')
  await card.getByRole('button', { name: 'Test Key' }).click()
  await expect(result).toContainText('treg did not accept this key')
  await field.fill('treg_mock_personal_token')
  await card.getByRole('button', { name: 'Test Key' }).click()
  await expect(result).toContainText('This is a personal treg login token')
  expect((await (await api.get('/api/settings')).json()).hasTregKey).toBe(false)

  // A team key: saving shows what treg says about it right away.
  await field.fill(MOCK_TEAM_KEY)
  await card.getByRole('button', { name: 'Save Key' }).click()
  await expect(card.getByText('Key configured', { exact: true })).toBeVisible()
  await expect(result).toContainText('Valid · Balance: $1.00 · Team: acme')
  await expect(field).toHaveValue('')
  expect((await (await api.get('/api/settings')).json()).hasTregKey).toBe(true)

  // Test Key with the field empty tests the saved key; holds are shown.
  await mockTreg.set({ balanceMicro: 4_100_000, holdsMicro: 800_000 })
  await card.getByRole('button', { name: 'Test Key' }).click()
  await expect(result).toContainText('Balance: $4.10 ($0.80 on hold)')

  // treg down: its own message, the saved key stays.
  await mockTreg.set({ down: true })
  await card.getByRole('button', { name: 'Test Key' }).click()
  await expect(result).toContainText("Can't reach treg")
  await mockTreg.set({ down: false })
  await expect(card.getByText('Key configured', { exact: true })).toBeVisible()

  // Only X-Treg-Token carries the key, every request names the client, and
  // the server never hands the key back.
  const seen = await mockTreg.requests()
  expect(seen.some(r => r.path === '/usage/me' && r.hasToken)).toBe(true)
  expect(seen.every(r => !('authorization' in r.headers))).toBe(true)
  expect(seen.every(r => r.headers['x-treg-client'] === 'cubex')).toBe(true)
  expect(await (await api.get('/api/settings')).text()).not.toContain(MOCK_TEAM_KEY)

  // Clear Key: back to no key.
  await card.getByRole('button', { name: 'Clear Key' }).click()
  await expect(card.getByText('No key configured', { exact: true })).toBeVisible()
  expect((await (await api.get('/api/settings')).json()).hasTregKey).toBe(false)
  await api.dispose()
})
