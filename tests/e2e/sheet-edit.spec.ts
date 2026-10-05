import { test, expect, APIRequestContext } from '@playwright/test'
import { authedApi, BASE } from './helpers'

// Regression guard: typing into a NEWLY ADDED column must not delete the row.
// The original bug was an autosave upsert that, for a column absent from
// rows.data, wrote a row shape the read path then pruned — the row vanished.
//
// Auth: cookie-based via authedApi() + context.addCookies() (the JWT lives in an
// HttpOnly cookie, never localStorage).
//
// Cell targeting: AG Grid col-ids are opaque stable tokens (col_<rand>), NEVER
// the column name — the stable-colId contract. The old [col-id="name"] selectors
// matched nothing. Target data cells by the 'col_' prefix and index by rendered
// column position (column_order = insertion order, so seeded col 0, new col 1).

async function seedRows(
  api: APIRequestContext, rowCount: number,
): Promise<{ tableId: string; sheetId: string }> {
  // Start from an empty workspace (every spec shares the one account).
  const existing = await (await api.get('/api/tables')).json()
  if (Array.isArray(existing)) for (const t of existing) await api.delete(`/api/tables/${t.id}`)
  const tbl = await api.post('/api/tables', { data: { name: `TestTable_${Date.now()}` } })
  expect(tbl.ok()).toBeTruthy()
  const body = await tbl.json()
  const tableId = body.id
  const sheetId = body.sheets[0].id

  // Adding the first column creates the placeholder row at index 0; the rest are
  // explicit blank rows. Values are written after the rows exist (upsert mode
  // does NOT create rows by index).
  await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: 'name' } })
  if (rowCount > 1) {
    const add = await api.post(`/api/sheets/${sheetId}/rows`, { data: { count: rowCount - 1 } })
    expect(add.ok()).toBeTruthy()
  }
  const updates = Array.from({ length: rowCount }, (_, i) => ({
    rowIndex: i, columnName: 'name', value: `name_${i}`,
  }))
  const put = await api.put(`/api/sheets/${sheetId}/data`, { data: { updates } })
  expect(put.ok()).toBeTruthy()
  return { tableId, sheetId }
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

// Drive the real UI "Add Column" flow (pinned header button → modal → submit).
async function addColumnViaUi(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.getByRole('button', { name: /add new column/i }).click()
  await page.getByPlaceholder(/e\.g\. notes/i).fill(name)
  await page.getByRole('button', { name: /^add column$/i }).click()
  await expect(page.locator('.ag-header-cell-text', { hasText: name })).toBeVisible({ timeout: 10_000 })
}

test('typing into a newly added column does not delete the row (1 row)', async ({ page, context }) => {
  const api = await authedApi()
  await context.addCookies((await api.storageState()).cookies)
  const { tableId } = await seedRows(api, 1)

  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  expect((await cellTexts(page, 0))[0]).toBe('name_0')

  await addColumnViaUi(page, 'firstName')

  await page.locator(dataCell(0, 1)).dblclick()
  await page.keyboard.type('Bob')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(800)

  // The row must survive, keeping BOTH its original and new value.
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible()
  const texts = await cellTexts(page, 0)
  expect(texts[0]).toBe('name_0')
  expect(texts[1]).toBe('Bob')
})

test('typing into a newly added column does not delete the row (5 rows)', async ({ page, context }) => {
  const api = await authedApi()
  await context.addCookies((await api.storageState()).cookies)
  const { tableId } = await seedRows(api, 5)

  await page.goto(`${BASE}/table/${tableId}`)
  for (let i = 0; i < 5; i++) {
    await expect(page.locator(`.ag-row[row-index="${i}"]`).first()).toBeVisible({ timeout: 15_000 })
  }

  await addColumnViaUi(page, 'firstName')

  // Edit the MIDDLE row — a bad upsert would strand or drop its neighbours.
  await page.locator(dataCell(2, 1)).dblclick()
  await page.keyboard.type('Bob')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(800)

  for (let i = 0; i < 5; i++) {
    await expect(page.locator(`.ag-row[row-index="${i}"]`).first()).toBeVisible()
    expect((await cellTexts(page, i))[0]).toBe(`name_${i}`)
  }
  expect((await cellTexts(page, 2))[1]).toBe('Bob')
})

test('editing the LAST row of a newly added column does not delete it', async ({ page, context }) => {
  const api = await authedApi()
  await context.addCookies((await api.storageState()).cookies)
  const { tableId } = await seedRows(api, 3)

  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="2"]').first()).toBeVisible({ timeout: 15_000 })

  await addColumnViaUi(page, 'age')

  await page.locator(dataCell(2, 1)).dblclick()
  await page.keyboard.type('99')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(800)

  await expect(page.locator('.ag-row[row-index="2"]').first()).toBeVisible()
  const texts = await cellTexts(page, 2)
  expect(texts[0]).toBe('name_2')
  expect(texts[1]).toBe('99')
})
