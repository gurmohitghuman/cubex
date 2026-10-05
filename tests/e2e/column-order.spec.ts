import { test, expect, APIRequestContext } from '@playwright/test'
import { authedApi, BASE } from './helpers'

// column_order is the position store: the read path derives columns from
// sheets.column_order, so insertion order (NOT alphabetical) is what the grid
// must render, and an explicit reorder must survive a reload.
//
// Auth: cookie-based via authedApi() + context.addCookies(), like every UI spec.
//
// A bare table is created directly rather than via seedSheet(), which would add
// its own 'val' column and pollute the exact-order assertions below.

async function seedBareTable(api: APIRequestContext): Promise<{ tableId: string; sheetId: string }> {
  // Start from an empty workspace: every spec shares the one account, so clear
  // whatever a prior test left behind.
  const existing = await (await api.get('/api/tables')).json()
  if (Array.isArray(existing)) for (const t of existing) await api.delete(`/api/tables/${t.id}`)
  const tbl = await api.post('/api/tables', { data: { name: `OrderTest_${Date.now()}` } })
  expect(tbl.ok()).toBeTruthy()
  const body = await tbl.json()
  return { tableId: body.id, sheetId: body.sheets[0].id }
}

async function addColumns(api: APIRequestContext, sheetId: string, names: string[]): Promise<void> {
  for (const columnName of names) {
    const res = await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName } })
    if (!res.ok()) throw new Error(`add column ${columnName} failed: ${await res.text()}`)
  }
}

async function getColumnHeadersFromGrid(page: import('@playwright/test').Page): Promise<string[]> {
  return await page.evaluate(() => {
    const headers = Array.from(document.querySelectorAll('.ag-header-cell'))
      .map(h => h.getAttribute('col-id'))
      .filter((id): id is string => !!id && !id.startsWith('__') && id !== 'ag-Grid-SelectionColumn')
    return headers
  })
}

// The grid keeps an opaque stable colId per column (col_<rand>) so a rename
// can't move it; the user-facing name lives in the header text. Read the
// rendered NAMES in DOM order to assert on order.
async function getHeaderNames(page: import('@playwright/test').Page): Promise<string[]> {
  return await page.evaluate(() => {
    const cells = Array.from(document.querySelectorAll('.ag-header-cell'))
      .filter(h => {
        const id = h.getAttribute('col-id')
        return !!id && !id.startsWith('__') && id !== 'ag-Grid-SelectionColumn'
      })
    return cells.map(c => (c.querySelector('.ag-header-cell-text')?.textContent ?? '').trim())
      .filter(Boolean)
  })
}

test('columns added in order Z, A, M render Z-A-M and stay that way after reload', async ({ page, context }) => {
  const api = await authedApi()
  const cookies = await api.storageState()
  await context.addCookies(cookies.cookies)
  const { tableId, sheetId } = await seedBareTable(api)

  await addColumns(api, sheetId, ['zulu', 'alpha', 'mike'])

  await page.goto(`${BASE}/table/${tableId}`)

  // Grid should show insertion order, not alphabetical.
  await expect(page.locator('.ag-header-cell-text', { hasText: 'zulu' })).toBeVisible({ timeout: 15_000 })
  expect(await getHeaderNames(page)).toEqual(['zulu', 'alpha', 'mike'])
  // colIds are opaque and stable — one per column, none leaked as a name.
  expect((await getColumnHeadersFromGrid(page)).length).toBe(3)

  // Reload — order must persist.
  await page.reload()
  await expect(page.locator('.ag-header-cell-text', { hasText: 'zulu' })).toBeVisible({ timeout: 15_000 })
  expect(await getHeaderNames(page)).toEqual(['zulu', 'alpha', 'mike'])
})

test('explicit reorder is persisted across reloads', async ({ page, context }) => {
  const api = await authedApi()
  const cookies = await api.storageState()
  await context.addCookies(cookies.cookies)
  const { tableId, sheetId } = await seedBareTable(api)

  await addColumns(api, sheetId, ['one', 'two', 'three'])

  // Reorder via API to simulate what an AG Grid drag would do.
  const reorder = await api.put(`/api/sheets/${sheetId}/columns/reorder`, {
    data: { columnOrder: ['three', 'one', 'two'] },
  })
  expect(reorder.ok()).toBeTruthy()

  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-header-cell-text', { hasText: 'one' })).toBeVisible({ timeout: 15_000 })
  expect(await getHeaderNames(page)).toEqual(['three', 'one', 'two'])

  // A newly added column lands at the END, preserving the explicit order.
  await addColumns(api, sheetId, ['four'])

  await page.reload()
  await expect(page.locator('.ag-header-cell-text', { hasText: 'four' })).toBeVisible({ timeout: 15_000 })
  expect(await getHeaderNames(page)).toEqual(['three', 'one', 'two', 'four'])
})
