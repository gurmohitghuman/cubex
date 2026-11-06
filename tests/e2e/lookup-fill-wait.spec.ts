import { test, expect } from '@playwright/test'
import { authedApi, getSheet, makeAccessToken, BASE } from './helpers'
import { seedLookupSheets } from './helpers-lookup'

// A lookup that reads a formula column of the other sheet while that column
// is still filling: it's accepted, waits for the fill (REST's answer, the
// sheet payload and the column's header say so), and fills by itself once
// the formula is done. Nobody clicks "Look up every row again".

// Blank rows under Companies (added 1,000 at a time, the most one request adds), each taking the
// formula 4 to 5 ms (a tenth of its 50 ms per-row limit, so a loaded machine doesn't fail the fill), so
// its fill (at least 48 s) outlasts REST's 10 s answer and the page's check by far.
const SLOW_BATCHES = 12
const FORMULA = '(() => { const t = Date.now() + 5; while (Date.now() < t) {} '
  + 'return {{Industry}} ? {{Industry}} + "!" : "" })()'
const NOTE = 'Waits for "Sector" in "Companies" to finish filling.'

test('a lookup reading a formula column that is still filling waits for it, then fills', async ({ page, context,
  playwright }) => {
  test.setTimeout(240_000)
  const api = await authedApi()
  const s = await seedLookupSheets(api)
  // Minted in the database before the formula's slices hold its write lock.
  const token = await makeAccessToken(api, ['read', 'write'], 'e2e lookup wait')
  for (let i = 0; i < SLOW_BATCHES; i++) {
    expect((await api.post(`/api/sheets/${s.companiesId}/rows`, { data: { count: 1_000 } })).ok()).toBeTruthy()
  }
  const formula = await api.post(`/api/sheets/${s.companiesId}/formula-columns`,
    { data: { column: 'Sector', formula: FORMULA } })
  expect(formula.ok(), await formula.text()).toBeTruthy()
  expect((await formula.json()).status).toBe('filling')

  // REST (as MCP lookup_column): accepted while Sector fills; its answer says what the fill waits for.
  const v1 = await playwright.request.newContext({
    baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  })
  const started = await v1.post(`/api/v1/sheets/${s.leadsId}/lookup-columns`, { data: {
    column: 'Sector', source_column: 'Domain', other_sheet_id: s.companiesId, match_column: 'Website',
    returns: 'value', return_column: 'Sector',
  } })
  expect(started.status(), await started.text()).toBe(201)
  expect(await started.json()).toMatchObject({ column: 'Sector', status: 'filling', waiting: NOTE })

  // The app: the sheet's lookup carries the note, and the column's header shows it.
  expect((await getSheet(api, s.leadsId)).data.lookupColumns.Sector).toMatchObject({ status: 'filling', waiting: NOTE })
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${s.leadsTable}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('lookup-icon').hover()
  await expect(page.getByTestId('header-tip')).toContainText(NOTE)

  // Once the formula is done, the lookup fills by itself, with the formula's values.
  await expect.poll(async () => (await getSheet(api, s.leadsId)).data.lookupColumns.Sector.status,
    { timeout: 180_000, intervals: [1_000] }).toBe('done')
  const sheet = await getSheet(api, s.leadsId)
  expect(sheet.data.rows.map((r: any) => r.data.Sector ?? '')).toEqual(['Robots!', 'Energy!', ''])
  expect(sheet.data.lookupColumns.Sector).toMatchObject({ status: 'done', filledRows: 2, error: null })
  await expect(page.locator('.ag-center-cols-container .ag-row[row-index="0"]')).toContainText('Robots!',
    { timeout: 15_000 })
  await v1.dispose()
})
