import { test, expect, type Page } from '@playwright/test'
import { authedApi, BASE, seedSheet } from './helpers'

// A tab opened before an update asks for the old build's table page file, which the
// update removed. The server answers a missing hashed file with a 404 (never
// index.html), the tab reloads once and opens the table on the new build, and a file
// still missing after that reload shows the error page with its message, no loop.

const SHEET_CHUNK = /\/assets\/SheetPage-[^/]+\.js$/
const SHOTS = process.env.E2E_SHOT_DIR || ''

async function openDashboardOnTable(page: Page, context: import('@playwright/test').BrowserContext) {
  const api = await authedApi()
  await context.addCookies((await api.storageState()).cookies)
  const { tableId } = await seedSheet(api, 3)
  const tables = await (await api.get('/api/tables')).json() as Array<{ id: string; name: string }>
  const name = tables.find(t => t.id === tableId)!.name
  let loads = 0
  page.on('load', () => { loads++ })
  await page.goto(`${BASE}/dashboard`)
  await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 })
  return { tableId, name, loads: () => loads }
}

test('a missing hashed file is a 404; client routes still get the app', async () => {
  const api = await authedApi()
  const gone = await api.get('/assets/SheetPage-gone1234.js')
  expect(gone.status()).toBe(404)
  expect(gone.headers()['cache-control']).toBe('no-store')
  const route = await api.get('/table/abc')
  expect(route.status()).toBe(200)
  expect(route.headers()['content-type']).toContain('text/html')
})

test('the table page file gone after an update: the tab reloads once and opens the table', async ({
  page, context,
}) => {
  const { tableId, name, loads } = await openDashboardOnTable(page, context)
  // The stale page (before any reload) can't get the file; the reloaded one can.
  let failed = 0
  await page.route(SHEET_CHUNK, route => {
    if (loads() > 1) return route.continue()
    failed++
    return route.fulfill({ status: 404, body: '' })
  })

  await page.getByText(name).click()
  await expect(page.locator('.ag-row[row-index="0"] [col-id^="col_"]')).toHaveText('v0', { timeout: 15_000 })
  expect(page.url()).toContain(`/table/${tableId}`)
  expect(failed).toBeGreaterThan(0)
  expect(loads()).toBe(2) // the dashboard, then the one reload
  await expect(page.getByText('Something went wrong')).toHaveCount(0)
})

test('the file still missing after the reload: the error page shows why, no reload loop', async ({
  page, context,
}) => {
  const { name, loads } = await openDashboardOnTable(page, context)
  let failed = 0
  await page.route(SHEET_CHUNK, route => { failed++; return route.fulfill({ status: 404, body: '' }) })

  await page.getByText(name).click()
  await expect(page.getByText('Something went wrong')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('route-error-detail')).toContainText(/dynamically imported module|SheetPage/i)
  await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible()
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/route-error-page.png` })
  // Each try asks twice (Vite's modulepreload link, then the import itself).
  const triedBeforeWait = failed
  await page.waitForTimeout(1_500)
  expect(failed).toBe(triedBeforeWait)
  expect(loads()).toBe(2) // the dashboard, then the one reload
})
