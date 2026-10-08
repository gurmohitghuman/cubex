import { test, expect, request as pwRequest, type Page, type BrowserContext } from '@playwright/test'
import { authedApi, seedSheet, importCsv, BASE, makeAccessToken } from './helpers'

// A background (silent) reload must not move a deep-scrolled viewport. It used
// to refetch only the first 1,000 rows and REPLACE the held window, so a user
// past row 1,000 saw their rows vanish and the grid snap back to ~row 980 on
// every reload (every ~15 s while a structured AI run filled the sheet). Now it
// refetches the held rows from the top in pages, or for a very deep viewport a
// slice around it (hooks/sheet/reloadWindow.ts).

const ROW_H = 32 // AGGridSpreadsheet rowHeight

const viewportTop = (page: Page) =>
  page.evaluate(() => (document.querySelector('.ag-body-viewport') as HTMLElement).scrollTop)

async function scrollToRow(page: Page, row: number): Promise<number> {
  // Each scroll-end pages in more rows; repeat until the grid is tall enough.
  for (let i = 0; i < 40; i++) {
    await page.evaluate((y) => {
      (document.querySelector('.ag-body-viewport') as HTMLElement).scrollTop = y
    }, row * ROW_H)
    await page.waitForTimeout(500)
    const top = await viewportTop(page)
    if (Math.abs(top - row * ROW_H) < ROW_H) return top
  }
  throw new Error(`could not scroll to row ${row}`)
}

// A sheet of `n` rows (name n0.., note a), opened and scrolled to `row`; plus a
// v1 client and every row id in order, for writes "from elsewhere".
async function openScrolled(page: Page, context: BrowserContext, n: number, row: number) {
  const api = await authedApi()
  await context.addCookies((await api.storageState()).cookies)
  const { tableId, sheetId } = await seedSheet(api, 1)
  const csv = ['name,note', ...Array.from({ length: n }, (_, i) => `n${i},a`)].join('\n')
  expect((await importCsv(api, sheetId, csv, { replaceData: true })).ok()).toBeTruthy()
  await expect.poll(async () =>
    (await (await api.get(`/api/sheets/${sheetId}?limit=1&offset=0`)).json()).data.totalRows,
  { timeout: 30_000 }).toBe(n)
  const v1 = await pwRequest.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${await makeAccessToken(api, ['read', 'write'], 'viewport keep')}` },
  })
  const ids: string[] = []
  for (let cursor: number | null = null; ;) {
    const query = `limit=1000${cursor !== null ? `&cursor=${cursor}` : ''}`
    const body: any = await (await v1.get(`/api/v1/sheets/${sheetId}/rows?${query}`)).json()
    ids.push(...body.rows.map((r: { id: string }) => r.id))
    if (body.next_cursor === null || body.next_cursor === undefined) break
    cursor = body.next_cursor
  }
  expect(ids.length).toBe(n)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  const top = await scrollToRow(page, row)
  return { v1, sheetId, ids, top }
}

const writeNote = (v1: Awaited<ReturnType<typeof openScrolled>>['v1'], sheetId: string, rowId: string, note: string) =>
  v1.post(`/api/v1/sheets/${sheetId}/rows/update`, { data: { updates: [{ row_id: rowId, data: { note } }] } })

// [label, sheet rows, scroll to, reload refetches from the top?]. The deep case
// holds > SILENT_RELOAD_MAX_ROWS with the viewport past it, so the reload takes
// the slice-merge path (its page requests start at an offset > 0).
const CASES = [['held window', 2500, 1500, true], ['very deep viewport', 6500, 5000, false]] as const
for (const [label, n, row, fromTop] of CASES) {
  test(`a background reload keeps the scroll and refreshes the rows in view (${label})`, async ({ page, context }) => {
    test.setTimeout(150_000)
    const { v1, sheetId, ids, top } = await openScrolled(page, context, n, row)
    const offsets: number[] = []
    page.on('request', r => {
      const url = new URL(r.url())
      if (url.pathname === `/api/sheets/${sheetId}`) offsets.push(Number(url.searchParams.get('offset') ?? 0))
    })
    // An API write to a row IN VIEW: data_version moves → the tab's silent reload.
    expect((await writeNote(v1, sheetId, ids[row + 5], `LIVE-${row + 5}`)).status()).toBe(200)
    await expect(page.locator(`.ag-row[row-index="${row + 5}"]`).getByText(`LIVE-${row + 5}`))
      .toBeVisible({ timeout: 15_000 })
    // …and the viewport never moved (it used to land near row 982).
    expect(Math.abs((await viewportTop(page)) - top)).toBeLessThan(ROW_H)
    expect(offsets[0] === 0).toBe(fromTop)
    await v1.dispose()
  })
}

test('rows deleted above a very deep viewport leave no stale or missing rows', async ({ page, context }) => {
  test.setTimeout(150_000)
  const { v1, sheetId, ids } = await openScrolled(page, context, 6500, 5000)
  // Deleting rows above the refreshed slice shifts every ordinal the tab holds;
  // the slice can't be placed, so the tab reloads from the top instead of
  // keeping the deleted rows and skipping as many further down.
  expect((await v1.post(`/api/v1/sheets/${sheetId}/rows/delete`, { data: { row_ids: ids.slice(0, 10) } })).ok())
    .toBeTruthy()
  await expect(page.getByText('6,490 rows')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.ag-center-cols-container .ag-row[row-index="0"]'))
    .toContainText('n10', { timeout: 15_000 })
  await v1.dispose()
})
