import { test, expect, Page, Locator, APIRequestContext } from '@playwright/test'
import { authedApi, seedSheet, BASE } from './helpers'
import { openColumnType } from './helpers-ui'

// The HTTP API column dialog's key picker: "Save for next time as" takes a
// name of at most API_KEY_NAME_MAX (200) characters, the longest a saved key
// can be saved with, so a longer one can't be typed only for the save to fail.
// A key with a name that long fits its row: in Settings and in the picker, the
// name ends in an ellipsis and the buttons beside it stay inside the box.
// In the "/" list a long key name is cut the same way, while a long column
// name wraps and shows whole.

const drawer = (page: Page) => page.locator('[role="dialog"]').filter({ hasText: 'HTTP API Column' })
const LONG = 'longkey_' + 'x'.repeat(192)
const SHORT = 'shortkey_picker'
// Its reference is wider than a row of the "/" list, so it fits only by breaking inside.
const COL = 'Annual revenue estimate for the parent company group'

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

async function deleteKeys(api: APIRequestContext) {
  const keys = await (await api.get('/api/settings/api-keys')).json()
  for (const k of keys) if (k.name === LONG || k.name === SHORT) await api.delete(`/api/settings/api-keys/${k.id}`)
}

async function saveKeys(api: APIRequestContext) {
  await deleteKeys(api)
  expect(LONG).toHaveLength(200)
  for (const name of [LONG, SHORT]) {
    const data = { name, key_type: 'api_key', key_value: 'v-0123456789' }
    expect((await api.post('/api/settings/api-keys', { data })).ok()).toBeTruthy()
  }
}

// Visible and wholly inside the outer box (half a pixel for rounding). acrossOnly checks only the
// horizontal fit: for a row of a list that scrolls, whatever rows other specs left above it.
async function expectInside(inner: Locator, outer: Locator, acrossOnly = false) {
  await expect(inner).toBeVisible()
  const a = (await inner.boundingBox())!
  const b = (await outer.boundingBox())!
  const across = a.x >= b.x - 0.5 && a.x + a.width <= b.x + b.width + 0.5
  const down = acrossOnly || (a.y >= b.y - 0.5 && a.y + a.height <= b.y + b.height + 0.5)
  expect(across && down, `${JSON.stringify(a)} inside ${JSON.stringify(b)}`).toBe(true)
}

// The box's text runs past its edge: cut off, or spilling out.
const overflows = (box: Locator) => box.evaluate(el => el.scrollWidth > el.clientWidth)

test('a 200-character key name fits its row in Settings and in the picker', async ({ page, context }) => {
  const api = await authedApi()
  try {
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
    const short = card.locator('div.rounded-lg').filter({ hasText: SHORT }).getByText(SHORT, { exact: true })
    expect(await overflows(short)).toBe(false)

    await page.goto(`${BASE}/table/${tableId}`)
    await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
    await openColumnType(page, 'HTTP API')
    const d = drawer(page)
    const bar = d.locator('div.bg-gray-50').filter({ hasText: 'AI assist' }).first()
    const picker = d.getByRole('button', { name: 'Saved key' })
    await picker.click()
    const options = page.getByRole('listbox')
    const option = options.locator(`[data-value="${LONG}"]`)
    await option.scrollIntoViewIfNeeded()
    await expectInside(option, options, true)
    await option.click()
    await expect(d.getByText('Using saved key:')).toBeVisible()
    await expectInside(picker, bar)
    await expectInside(d.getByRole('button', { name: 'Use a different key' }), bar)
  } finally {
    await deleteKeys(api)
    await api.dispose()
  }
})

test('the "/" list wraps a long column name and cuts a long key name', async ({ page, context }) => {
  const api = await authedApi()
  try {
    await saveKeys(api)
    const { tableId, sheetId } = await seedSheet(api, 1)
    expect((await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: COL } })).ok()).toBeTruthy()
    await context.addCookies((await api.storageState()).cookies)
    await page.setViewportSize({ width: 1400, height: 900 })
    await page.goto(`${BASE}/table/${tableId}`)
    await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
    await openColumnType(page, 'HTTP API')
    await drawer(page).locator('input[placeholder="https://api.example.com/data"]').fill('/')
    const list = page.locator('div.max-w-sm').filter({ hasText: 'Type / to insert column or API key' })

    // The column row wraps: its whole name shows inside the row and nothing runs past the row's edge.
    const col = list.getByRole('button').filter({ hasText: `(${COL})` })
    await col.scrollIntoViewIfNeeded()
    await expectInside(col, list, true)
    await expectInside(col.getByText(`(${COL})`, { exact: true }), col)
    expect(await overflows(col)).toBe(false)

    // A long key row stays on one line, cut at the row's edge inside the list.
    const key = list.getByTitle(`/${LONG}`, { exact: true })
    await key.scrollIntoViewIfNeeded()
    await expectInside(key, list, true)
    expect(await overflows(key)).toBe(true)
    expect(await key.evaluate(el => [getComputedStyle(el).overflowX, getComputedStyle(el).whiteSpace]))
      .toEqual(['hidden', 'nowrap'])
  } finally {
    await deleteKeys(api)
    await api.dispose()
  }
})
