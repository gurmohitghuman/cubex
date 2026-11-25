import { test, expect } from '@playwright/test'
import { authedApi, BASE, getSheet, seedSheet } from './helpers'

// The home's Rows column (server lib/row-counts.ts, services/table-row-counts.ts): the list answers at once, a table
// whose rows changed since they were counted shows its last count marked as updating, and the new count follows
// from GET /api/tables/row-counts. Rows are added and deleted the way the grid does (POST /rows, bulk-delete), which
// move neither data_version nor row_generation.
test('the home shows a table\'s rows; after rows are added and deleted, the last count as updating, then the new one',
  async ({ page, context }) => {
    test.setTimeout(60_000)
    const api = await authedApi()
    await context.addCookies((await api.storageState()).cookies)
    const { tableId, sheetId } = await seedSheet(api, 4)
    const count = page.locator(`[data-testid="table-row-count"][data-table-id="${tableId}"]`)

    await page.goto(`${BASE}/`)
    await expect(count).toHaveText('4', { timeout: 15_000 })
    await expect(count.getByLabel('Updating')).toHaveCount(0)

    expect((await api.post(`/api/sheets/${sheetId}/rows`, { data: { count: 3 } })).ok()).toBeTruthy()
    const sheet = await getSheet(api, sheetId)
    const del = await api.post(`/api/sheets/${sheetId}/rows/bulk-delete`, {
      data: { rowIndices: [0, 5], rowGeneration: sheet.sheet.row_generation ?? 0 },
    })
    expect(del.ok()).toBeTruthy()

    // The home's wait for the new count held here, so the last one shows as updating until it is let through.
    let letThrough!: () => void
    const gate = new Promise<void>(r => { letThrough = r })
    await page.route('**/api/tables/row-counts', async route => { await gate; await route.continue() })
    const listed = page.waitForResponse(r => new URL(r.url()).pathname === '/api/tables')
    await page.goto(`${BASE}/`)
    const tables = await (await listed).json() as Array<{ id: string; row_count: number; row_count_updating: boolean }>
    expect(tables.find(t => t.id === tableId)).toMatchObject({ row_count: 4, row_count_updating: true })
    await expect(count).toHaveText('4')
    await expect(count.getByLabel('Updating')).toBeVisible()

    const counted = page.waitForResponse(r => new URL(r.url()).pathname === '/api/tables/row-counts')
    letThrough()
    const answer = await (await counted).json() as { tables: Array<{ id: string; row_count: number }> }
    expect(answer.tables.find(t => t.id === tableId)).toMatchObject({ row_count: 5, row_count_updating: false })
    await expect(count).toHaveText('5')
    await expect(count.getByLabel('Updating')).toHaveCount(0)
  })

// A 429 (the account already holds its waits for counts: other tabs of the home) leaves the counts marked as
// updating, since they are: the page doesn't show them as final.
test('a refused wait for the new counts keeps them marked as updating', async ({ page, context }) => {
  const api = await authedApi()
  await context.addCookies((await api.storageState()).cookies)
  const { tableId, sheetId } = await seedSheet(api, 4)
  const count = page.locator(`[data-testid="table-row-count"][data-table-id="${tableId}"]`)
  await page.goto(`${BASE}/`)
  await expect(count).toHaveText('4', { timeout: 15_000 })

  expect((await api.post(`/api/sheets/${sheetId}/rows`, { data: { count: 2 } })).ok()).toBeTruthy()
  await page.route('**/api/tables/row-counts', route =>
    route.fulfill({ status: 429, json: { error: 'Too many home pages are open. Close one, then reload this page.' } }))
  const refused = page.waitForResponse(r => new URL(r.url()).pathname === '/api/tables/row-counts')
  await page.goto(`${BASE}/`)
  expect((await refused).status()).toBe(429)
  await expect(count).toHaveText('4')
  // After the refusal, as the page has it: still marked, no other count asked for.
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
  await expect(count.getByLabel('Updating')).toBeVisible()
  await expect(count).toHaveAttribute('title', 'Counting the rows again')
})

