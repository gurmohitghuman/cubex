import { test, expect, request as pwRequest, APIRequestContext } from '@playwright/test'
import { authedApi, seedSheet, BASE, makeAccessToken } from './helpers'

// Slice 2c: an OPEN BROWSER TAB picks up /api/v1 writes live via the
// generalized change poll — silent reload for data-only changes (append,
// patch), LOUD reload when row_generation moves (v1 sort). Also proves the
// /changes since_rg resolution at the API level.

const DATA_CELL = (row: number) => `.ag-row[row-index="${row}"] [col-id^="col_"]`

// Delegates to helpers.makeAccessToken, which mints straight into the test DB.
async function makeToken(api: APIRequestContext): Promise<string> {
  return makeAccessToken(api, ['read', 'write'], 'e2e live tab')
}

test('open tab live-updates on v1 append (silent) and v1 sort (loud)', async ({ page, context }) => {
  const api = await authedApi()
  const cookies = await api.storageState()
  await context.addCookies(cookies.cookies)
  const { tableId, sheetId } = await seedSheet(api, 3) // val: v0, v1, v2

  const v1 = await pwRequest.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${await makeToken(api)}` },
  })

  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator(DATA_CELL(0)).first()).toHaveText('v0', { timeout: 15_000 })

  // v1 append → data_version bump → held poll resolves → SILENT reload shows
  // the new row without any user action.
  const app = await v1.post(`/api/v1/sheets/${sheetId}/rows`, { data: { rows: [{ data: { val: 'LIVE' } }] } })
  expect(app.status()).toBe(201)
  await expect(page.locator(DATA_CELL(3)).first()).toHaveText('LIVE', { timeout: 15_000 })

  // v1 patch of row 0 → silent reload repaints the cell in place. Silent
  // reloads are spaced SILENT_RELOAD_MIN_GAP_MS (15s, useLiveSheetUpdates)
  // apart, so this one lands ~15s after the append's reload above: a 15s
  // timeout raced that gap by design and failed intermittently.
  const rows = await (await v1.get(`/api/v1/sheets/${sheetId}/rows`)).json()
  const zzz = await v1.patch(`/api/v1/rows/${rows.rows[0].id}`, { data: { data: { val: 'ZZZ' } } })
  expect(zzz.status()).toBe(200)
  await expect(page.locator(DATA_CELL(0)).first()).toHaveText('ZZZ', { timeout: 25_000 })

  // v1 sort asc (LIVE < v1 < v2 < ZZZ) → row_generation moves → the tab does a
  // LOUD reload and row 0 becomes LIVE. This is the structural path: the tab's
  // rowGenerationRef holds the OLD generation, so it must reload, not overlay.
  const sort = await v1.post(`/api/v1/sheets/${sheetId}/sort`, { data: { column: 'val', direction: 'asc' } })
  expect(sort.status()).toBe(200)
  await expect(page.locator(DATA_CELL(0)).first()).toHaveText('LIVE', { timeout: 15_000 })
  await expect(page.locator(DATA_CELL(3)).first()).toHaveText('ZZZ')

  await v1.dispose()
})

test('/changes resolves immediately on a row_generation mismatch (since_rg)', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2)

  // Baseline read (no hold: since=-1 is always behind).
  const base = await (await api.get(`/api/sheets/${sheetId}/changes?since=-1`)).json()
  expect(base.changed).toBe(true)

  // Same dv, mismatched rg → resolves immediately with changed:true (a UI sort
  // bumps ONLY rg; without since_rg the poll would sit until the heartbeat).
  const t0 = Date.now()
  const rgMiss = await (await api.get(
    `/api/sheets/${sheetId}/changes?since=${base.dataVersion}&since_rg=${base.rowGeneration - 1}`,
  )).json()
  expect(rgMiss.changed).toBe(true)
  expect(rgMiss.rowGeneration).toBe(base.rowGeneration)
  expect(Date.now() - t0).toBeLessThan(3000)
})

test('open tab follows sheets created, renamed and deleted over the API', async ({ page, context }) => {
  test.setTimeout(60_000)
  const api = await authedApi()
  await context.addCookies((await api.storageState()).cookies)
  const { tableId, sheetId } = await seedSheet(api, 1)
  const v1 = await pwRequest.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${await makeToken(api)}` },
  })
  const tabs = () => page.locator('button[aria-label^="Sheet options for "]')
    .evaluateAll(els => els.map(e => e.getAttribute('aria-label')!.replace('Sheet options for ', '')))

  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator(DATA_CELL(0)).first()).toHaveText('v0', { timeout: 15_000 })

  // The table GET seeds the poll's tab-list key; a new sheet moves it.
  expect((await v1.post(`/api/v1/tables/${tableId}/sheets`, { data: { name: 'Second' } })).status()).toBe(201)
  expect((await v1.patch(`/api/v1/tables/${tableId}/sheets/${sheetId}`, { data: { name: 'Renamed' } })).status()).toBe(200)
  await expect.poll(tabs, { timeout: 15_000 }).toEqual(['Renamed', 'Second'])

  // Deleting the open sheet: a toast, and the tab moves to the survivor.
  expect((await v1.delete(`/api/v1/tables/${tableId}/sheets/${sheetId}`)).status()).toBe(200)
  await expect(page.getByText('The sheet "Renamed" was deleted somewhere else.')).toBeVisible({ timeout: 15_000 })
  await expect.poll(tabs).toEqual(['Second'])
  await expect(page).not.toHaveURL(new RegExp(sheetId))

  // Deleting the table: back to the dashboard.
  expect((await v1.delete(`/api/v1/tables/${tableId}`)).status()).toBe(200)
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 15_000 })
  await v1.dispose()
})

test('/changes resolves when the table\'s tab list moves (since_sk)', async () => {
  const api = await authedApi()
  const { tableId, sheetId } = await seedSheet(api, 1)
  const table = await (await api.get(`/api/tables/${tableId}`)).json()
  const base = await (await api.get(`/api/sheets/${sheetId}/changes?since=-1`)).json()
  expect(base.sheetsKey).toBe(table.sheets_key)

  expect((await api.post(`/api/tables/${tableId}/sheets`, { data: { name: 'Two' } })).ok()).toBeTruthy()
  const t0 = Date.now()
  const moved = await (await api.get(
    `/api/sheets/${sheetId}/changes?since=${base.dataVersion}&since_rg=${base.rowGeneration}&since_sk=${base.sheetsKey}`,
  )).json()
  expect(moved.changed).toBe(true)
  expect(moved.sheetsKey).not.toBe(base.sheetsKey)
  expect(Date.now() - t0).toBeLessThan(3000)
})
