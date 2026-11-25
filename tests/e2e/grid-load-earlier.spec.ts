import { test, expect, type Page } from '@playwright/test'
import { authedApi, importCsv, BASE } from './helpers'

// The grid holds a window of rows that can start deep (a search jumped there). Scrolled to near the window's top,
// it loads the rows above it, and the row first in view stays exactly where it was: same row, same pixel (a
// scroll anchor, as browsers keep one). It used to keep the first row AG Grid renders on top, up to 30 rows above
// the view, so the view jumped.

// The "#" of the row at the top of the grid's view, and how far the view's top is past that row's top.
async function topOfView(page: Page): Promise<{ row: string; offset: number } | null> {
  return page.evaluate(() => {
    const view = document.querySelector('.ag-body-viewport')!.getBoundingClientRect()
    const rows = [...document.querySelectorAll<HTMLElement>('.ag-pinned-left-cols-container .ag-row')]
    const row = rows.map(r => ({ r, box: r.getBoundingClientRect() }))
      .filter(x => x.box.top <= view.top + 0.5 && x.box.bottom > view.top + 0.5)
      .sort((a, b) => b.box.top - a.box.top)[0]
    return row ? { row: row.r.innerText.trim(), offset: Math.round(view.top - row.box.top) } : null
  })
}
const firstHeld = async (page: Page) => Number((await page.locator('.ag-pinned-left-cols-container .ag-row')
  .first().innerText()).trim())

test('rows loading above a deep window keep the row in view where it was', async ({ page, context }) => {
  test.setTimeout(120_000)
  const api = await authedApi()
  const existing = await (await api.get('/api/tables')).json()
  if (Array.isArray(existing)) for (const t of existing) await api.delete(`/api/tables/${t.id}`)
  const table = await (await api.post('/api/tables', { data: { name: `Anchor ${Date.now()}` } })).json()
  const sheetId = table.sheets[0].id as string
  const lines = ['Name,Tag']
  for (let i = 0; i < 3000; i++) lines.push(`row ${i},${i === 2500 ? 'needle' : `tag ${i}`}`)
  expect((await importCsv(api, sheetId, lines.join('\n'), { replaceData: true })).ok()).toBeTruthy()

  await page.setViewportSize({ width: 1280, height: 800 })
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${table.id}/${sheetId}`)
  await page.locator('.ag-center-cols-container .ag-row').first().waitFor()
  // Search moves the grid to a window that starts deep.
  await page.locator('.ag-center-cols-container .ag-cell[col-id^="col_"]').first().click()
  await page.keyboard.press('/')
  await page.getByLabel('Search the sheet').fill('needle')
  await expect(page.locator('.ag-center-cols-container .cubex-search-hit')).toHaveText('needle', { timeout: 15_000 })
  await page.getByLabel('Search the sheet').press('Escape')
  const before = await firstHeld(page)
  expect(before).toBeGreaterThan(1000)

  // Near the window's top, part of a row scrolled past: the rows above load.
  await page.locator('.ag-body-viewport').evaluate(el => { el.scrollTop = 5 * 32 + 13 })
  // AG Grid draws the rows for the new place on its next frame.
  await expect.poll(() => topOfView(page)).toEqual({ row: String(before + 5), offset: 13 })
  const inView = await topOfView(page)
  await expect.poll(() => firstHeld(page), { timeout: 15_000 }).toBeLessThan(before)
  await page.waitForTimeout(300)
  expect(await topOfView(page)).toEqual(inView)
})
