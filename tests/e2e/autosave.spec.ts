import { test, expect, APIRequestContext } from '@playwright/test'
import { authedApi, BASE } from './helpers'

// Autosave is the SINGLE persistence driver: cellValueChanged → debounced batch
// PUT /:id/data. There is no Save button, and an edit must survive a reload.
//
// Auth: cookie-based via authedApi() + context.addCookies() (the JWT lives in an
// HttpOnly cookie, never localStorage).
//
// Cell targeting: AG Grid col-ids are opaque stable tokens (col_<rand>), NEVER
// the column name — that's the stable-colId contract. Target data cells by the
// 'col_' prefix and disambiguate by header POSITION, not by [col-id="name"],
// which never matches anything.

async function seedTwoColumnSheet(
  api: APIRequestContext,
): Promise<{ tableId: string; sheetId: string }> {
  // Start from an empty workspace (every spec shares the one account).
  const existing = await (await api.get('/api/tables')).json()
  if (Array.isArray(existing)) for (const t of existing) await api.delete(`/api/tables/${t.id}`)
  const tbl = await api.post('/api/tables', { data: { name: `AutosaveTest_${Date.now()}` } })
  expect(tbl.ok()).toBeTruthy()
  const body = await tbl.json()
  const tableId = body.id
  const sheetId = body.sheets[0].id

  // First column creates the single placeholder row at index 0.
  await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: 'name' } })
  await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: 'email' } })
  const put = await api.put(`/api/sheets/${sheetId}/data`, {
    data: { updates: [{ rowIndex: 0, columnName: 'name', value: 'Alice' }] },
  })
  expect(put.ok()).toBeTruthy()
  return { tableId, sheetId }
}

// Nth data cell of a row, in rendered column order ('name' = 0, 'email' = 1).
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

test('cell edit autosaves without a Save button (Google-Sheets style)', async ({ page, context }) => {
  const api = await authedApi()
  const cookies = await api.storageState()
  await context.addCookies(cookies.cookies)
  const { tableId } = await seedTwoColumnSheet(api)

  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })

  // Sanity check: there is no "Save" button on the page.
  await expect(page.getByRole('button', { name: /^save$/i })).toHaveCount(0)

  const cell = page.locator(dataCell(0, 0))
  await expect(cell).toHaveText('Alice')
  await cell.dblclick()
  // ControlOrMeta = Cmd on macOS (Control+A there is move-to-line-start, which
  // would prepend instead of replace). Select-all then overtype.
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('Alice Edited')
  await page.keyboard.press('Enter')

  // Autosave debounce is 100ms; give the flush room before asserting.
  await page.waitForTimeout(800)

  // Reload — the value must have persisted with no explicit save.
  await page.reload()
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  expect((await cellTexts(page, 0))[0]).toBe('Alice Edited')
})

test('autosave persists rapid edits to multiple cells', async ({ page, context }) => {
  const api = await authedApi()
  const cookies = await api.storageState()
  await context.addCookies(cookies.cookies)
  const { tableId } = await seedTwoColumnSheet(api)

  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })

  // Edit both cells back-to-back so they land in ONE debounced batch — the case
  // where a mis-keyed queue would drop or misroute the earlier edit.
  await page.locator(dataCell(0, 0)).dblclick()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('Bob')
  await page.keyboard.press('Enter')

  await page.locator(dataCell(0, 1)).dblclick()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('bob@example.com')
  await page.keyboard.press('Enter')

  await page.waitForTimeout(1000)

  await page.reload()
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  const texts = await cellTexts(page, 0)
  expect(texts[0]).toBe('Bob')
  expect(texts[1]).toBe('bob@example.com')
})
