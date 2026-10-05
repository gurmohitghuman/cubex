import { test, expect, request as pwRequest, APIRequestContext } from '@playwright/test'

// Same scenario as sheet-edit.spec.ts but pointed at DEV mode (client:3000,
// server:3002), where React StrictMode double-invokes effects and surfaces races
// the production build can hide.
//
// This spec does NOT run under scripts/e2e-harness.sh: the harness boots a
// production build on :3099 against a throwaway DB, and nothing is listening on
// 3000/3002. Previously it just failed there (looking like a product bug); now
// it SKIPS unless a dev server is actually up. To run it:
//
//   npm run dev            # in one terminal
//   npx playwright test tests/e2e/sheet-edit-dev.spec.ts
//
// It talks to the DEV database (server/data/cubex.db), so it signs in with your
// dev password (DEV_PASSWORD, default password123) and cleans up the tables it
// creates.

const API_BASE = process.env.DEV_API_BASE || 'http://localhost:3002'
const CLIENT_BASE = process.env.DEV_CLIENT_BASE || 'http://localhost:3000'
const DEV_PASSWORD = process.env.DEV_PASSWORD || 'password123'

async function devServerUp(): Promise<boolean> {
  try {
    const ctx = await pwRequest.newContext()
    const res = await ctx.get(`${API_BASE}/api/health`, { timeout: 2000 })
    await ctx.dispose()
    return res.ok()
  } catch {
    return false
  }
}

// Null when the dev account's password isn't DEV_PASSWORD: the spec then skips
// instead of failing, like it does when no dev server is up.
async function devApi(): Promise<APIRequestContext | null> {
  const ctx = await pwRequest.newContext({ baseURL: API_BASE })
  const res = await ctx.post('/api/auth/login', {
    data: { password: DEV_PASSWORD },
  })
  if (res.ok()) return ctx
  await ctx.dispose()
  return null
}

const dataCell = (row: number, n: number) =>
  `.ag-row[row-index="${row}"] [col-id^="col_"] >> nth=${n}`

async function cellTexts(page: import('@playwright/test').Page, row: number): Promise<string[]> {
  return await page.evaluate((r) => {
    const cells = Array.from(
      document.querySelectorAll(`.ag-row[row-index="${r}"] [col-id^="col_"]`),
    )
    return cells.map(c => (c.textContent ?? '').trim())
  }, row)
}

test('DEV: typing into a newly added column does not delete the row', async ({ page, context }) => {
  test.skip(!(await devServerUp()), `no dev server on ${API_BASE} — run "npm run dev" first`)
  test.setTimeout(60_000)

  const api = await devApi()
  test.skip(!api, 'dev login failed: set your dev password with DEV_PASSWORD')
  if (!api) return
  await context.addCookies((await api.storageState()).cookies)

  // Dev DB is the user's real working DB — create a uniquely named table and
  // remove it afterwards rather than clearing whatever else is in there.
  const tbl = await api.post('/api/tables', { data: { name: `DevEditTest_${Date.now()}` } })
  expect(tbl.ok()).toBeTruthy()
  const body = await tbl.json()
  const tableId = body.id
  const sheetId = body.sheets[0].id

  try {
    await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: 'name' } })
    const add = await api.post(`/api/sheets/${sheetId}/rows`, { data: { count: 2 } })
    expect(add.ok()).toBeTruthy()
    const put = await api.put(`/api/sheets/${sheetId}/data`, {
      data: {
        updates: Array.from({ length: 3 }, (_, i) => ({
          rowIndex: i, columnName: 'name', value: `name_${i}`,
        })),
      },
    })
    expect(put.ok()).toBeTruthy()

    await page.goto(`${CLIENT_BASE}/table/${tableId}`)
    for (let i = 0; i < 3; i++) {
      await expect(page.locator(`.ag-row[row-index="${i}"]`).first()).toBeVisible({ timeout: 20_000 })
    }

    await page.getByRole('button', { name: /add new column/i }).click()
    await page.getByPlaceholder(/e\.g\. notes/i).fill('firstName')
    await page.getByRole('button', { name: /^add column$/i }).click()
    await expect(page.locator('.ag-header-cell-text', { hasText: 'firstName' }))
      .toBeVisible({ timeout: 10_000 })

    // Edit the MIDDLE row's new column.
    await page.locator(dataCell(1, 1)).dblclick()
    await page.keyboard.type('Bob')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1000)

    for (let i = 0; i < 3; i++) {
      await expect(page.locator(`.ag-row[row-index="${i}"]`).first()).toBeVisible()
      expect((await cellTexts(page, i))[0]).toBe(`name_${i}`)
    }
    expect((await cellTexts(page, 1))[1]).toBe('Bob')
  } finally {
    await api.delete(`/api/tables/${tableId}`)
  }
})
