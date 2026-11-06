import { test, expect, Page, Locator, APIRequestContext } from '@playwright/test'
import { authedApi, seedSheet, BASE } from './helpers'
import { openColumnType } from './helpers-ui'

// The HTTP API column dialog's key picker: "Save for next time as" takes a
// name of at most API_KEY_NAME_MAX (200) characters, the longest a saved key
// can be saved with, so a longer one can't be typed only for the save to fail.
// A key with a name that long fits its row: in Settings and in the picker, the
// name ends in an ellipsis and the buttons beside it stay inside the box.

const drawer = (page: Page) => page.locator('[role="dialog"]').filter({ hasText: 'HTTP API Column' })
const LONG = 'longkey_' + 'x'.repeat(192)
const SHORT = 'shortkey_picker'

test('"Save for next time as" stops at 200 characters', async ({ page, context }) => {
  const api = await authedApi()
  const { tableId } = await seedSheet(api, 1)
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  await openColumnType(page, 'HTTP API')
  const d = drawer(page)

  await d.getByPlaceholder('Paste your API key here').fill('sk-picker-e2e-0123456789')
  await d.getByText('Save for next time as').click()
  const name = d.getByPlaceholder('e.g. Apollo')
  await expect(name).toBeEnabled()
  await expect(name).toHaveAttribute('maxlength', '200')
  await name.pressSequentially('k'.repeat(205))
  await expect(name).toHaveValue('k'.repeat(200))
  await api.dispose()
})

async function saveKeys(api: APIRequestContext) {
  const keys = await (await api.get('/api/settings/api-keys')).json()
  for (const k of keys) if (k.name === LONG || k.name === SHORT) await api.delete(`/api/settings/api-keys/${k.id}`)
  expect(LONG).toHaveLength(200)
  for (const name of [LONG, SHORT]) {
    const data = { name, key_type: 'api_key', key_value: 'v-0123456789' }
    expect((await api.post('/api/settings/api-keys', { data })).ok()).toBeTruthy()
  }
}

// Visible and wholly inside the outer box (half a pixel for rounding).
async function expectInside(inner: Locator, outer: Locator) {
  await expect(inner).toBeVisible()
  const a = (await inner.boundingBox())!
  const b = (await outer.boundingBox())!
  expect(a.x >= b.x - 0.5 && a.x + a.width <= b.x + b.width + 0.5 && a.y >= b.y - 0.5
    && a.y + a.height <= b.y + b.height + 0.5, `${JSON.stringify(a)} inside ${JSON.stringify(b)}`).toBe(true)
}

test('a 200-character key name fits its row in Settings and in the picker', async ({ page, context }) => {
  const api = await authedApi()
  await saveKeys(api)
  const { tableId } = await seedSheet(api, 1)
  await context.addCookies((await api.storageState()).cookies)
  await page.setViewportSize({ width: 1400, height: 900 })

  await page.goto(`${BASE}/settings/http-enrichment`)
  const card = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'External service keys' }) })
  const row = card.locator('div.rounded-lg').filter({ hasText: LONG })
  await expect(row).toHaveCount(1, { timeout: 15_000 })
  for (const title of ['Edit API key', 'Delete API key']) {
    await expectInside(row.getByTitle(title), row)
    await expectInside(row.getByTitle(title), card)
  }
  await expectInside(row.getByText(LONG, { exact: true }), card)

  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  await openColumnType(page, 'HTTP API')
  const d = drawer(page)
  const bar = d.locator('div.bg-gray-50').filter({ hasText: 'AI assist' }).first()
  const picker = d.getByRole('button', { name: 'Saved key' })
  await picker.click()
  const options = page.getByRole('listbox')
  await expectInside(options.locator(`[data-value="${LONG}"]`), options)
  await options.locator(`[data-value="${LONG}"]`).click()
  await expect(d.getByText('Using saved key:')).toBeVisible()
  await expectInside(picker, bar)
  await expectInside(d.getByRole('button', { name: 'Use a different key' }), bar)

  const keys = await (await api.get('/api/settings/api-keys')).json()
  for (const k of keys) if (k.name === LONG || k.name === SHORT) await api.delete(`/api/settings/api-keys/${k.id}`)
  await api.dispose()
})
