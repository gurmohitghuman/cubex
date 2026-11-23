import { test, expect, request as pwRequest, type APIRequestContext, type Page } from '@playwright/test'
import { authedApi, BASE, importCsv, makeAccessToken } from './helpers'

// An open tab shows a change made elsewhere within seconds, on a sheet of 10,000 rows: an /api/v1 write and the
// formula column (a derived column) that follows it. The tab's background reloads are paced by their own cost
// (client/src/hooks/sheet/reloadPacer.ts): one at a time, with a rest of 4x the last one's time, 1 to 15 s. Before,
// they were 15 s apart, so a derived cell could show about 18 s after the API had it.
const ROWS = 10_000
const SHOWN_WITHIN_MS = 5_000
let api: APIRequestContext
let v1: APIRequestContext
let tableId = ''
let sheetId = ''
let rowIds: string[] = []

test.beforeAll(async () => {
  test.setTimeout(120_000)
  api = await authedApi()
  for (const t of await (await api.get('/api/tables')).json()) await api.delete(`/api/tables/${t.id}`)
  const table = await (await api.post('/api/tables', { data: { name: 'Live derived' } })).json()
  tableId = table.id
  sheetId = table.sheets[0].id
  const csv = ['Id,Name', ...Array.from({ length: ROWS }, (_, i) => `${i + 1},name ${i + 1}`)].join('\n')
  const imported = await importCsv(api, sheetId, csv, { replaceData: true })
  expect(imported.ok(), await imported.text()).toBeTruthy()
  const formula = await api.post(`/api/sheets/${sheetId}/formula-columns`,
    { data: { column: 'Shout', formula: '{{Name}}.toUpperCase()' } })
  expect(formula.ok(), await formula.text()).toBeTruthy()
  await expect.poll(async () => (await shouts(10))[9], { timeout: 60_000 }).toBe('NAME 10')
  const token = await makeAccessToken(api, ['read', 'write'], 'e2e live derived')
  v1 = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${token}` } })
  rowIds = ((await (await v1.get(`/api/v1/sheets/${sheetId}/rows?limit=10`)).json()).rows as Array<{ id: string }>)
    .map(r => r.id)
  expect(rowIds).toHaveLength(10)
})
test.afterAll(async () => { await v1?.dispose(); await api?.dispose() })

// The first rows' Shout, as the API has them (a small read, so asking often doesn't load the server).
async function shouts(n: number): Promise<string[]> {
  const res = await api.get(`/api/sheets/${sheetId}?limit=${n}&offset=0`)
  expect(res.ok()).toBeTruthy()
  return ((await res.json()).data.rows as Array<{ data: Record<string, string> }>).map(r => r.data.Shout)
}

async function openGrid(page: Page) {
  await page.context().addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  // Row 10's Id: the tests before may have written its Name.
  await expect(page.locator('.ag-center-cols-container .ag-row[row-index="9"]')).toContainText('10',
    { timeout: 30_000 })
}

// Writes row i's Name over /api/v1, then times, on one clock, when the API has its Shout and when the grid shows
// it: the grid is watched from before the write, every frame.
async function writeAndTime(page: Page, i: number, name: string): Promise<{ api: number; grid: number }> {
  const want = name.toUpperCase()
  const shown = page.waitForFunction(([row, text]) => {
    const el = document.querySelector(`.ag-center-cols-container .ag-row[row-index="${row}"]`)
    return el?.textContent?.includes(text) ? Date.now() : false
  }, [i, want] as const, { polling: 'raf', timeout: 60_000 })
  const res = await v1.patch(`/api/v1/rows/${rowIds[i]}`, { data: { data: { Name: name } } })
  expect(res.status()).toBe(200)
  let apiAt = 0
  while (!apiAt) {
    const all = await shouts(i + 1)
    if (all[i] === want) apiAt = Date.now()
    else await new Promise(r => setTimeout(r, 50))
  }
  const gridAt = await (await shown).jsonValue() as number
  return { api: apiAt, grid: gridAt }
}

test('a derived cell shows within seconds of the API having it, write after write', async ({ page }) => {
  test.setTimeout(120_000)
  await openGrid(page)
  const delays: number[] = []
  // Back to back: each write lands while the reload of the one before is resting.
  for (let i = 0; i < 6; i++) {
    const t = await writeAndTime(page, i, `round ${i} name`)
    delays.push(Math.max(0, t.grid - t.api))
  }
  console.log(`[live-derived] grid after the API, ms: ${delays.join(', ')}`)
  for (const ms of delays) expect(ms).toBeLessThan(SHOWN_WITHIN_MS)
})

test('a writer once a second for 30 s: the tab\'s reloads never overlap, at most one a second', async ({ page }) => {
  test.setTimeout(150_000)
  await openGrid(page)
  // The tab's reads of the sheet's rows (GET /api/sheets/:id), from here on.
  const reads: Array<{ start: number; end: number | null }> = []
  const open = new Map<object, { start: number; end: number | null }>()
  let most = 0
  page.on('request', r => {
    if (new URL(r.url()).pathname !== `/api/sheets/${sheetId}`) return
    const read = { start: Date.now(), end: null as number | null }
    reads.push(read)
    open.set(r, read)
    most = Math.max(most, open.size)
  })
  const done = (r: object) => {
    const read = open.get(r)
    if (read) { read.end = Date.now(); open.delete(r) }
  }
  page.on('requestfinished', done)
  page.on('requestfailed', done)

  const started = Date.now()
  for (let s = 0; s < 30; s++) {
    const res = await v1.patch(`/api/v1/rows/${rowIds[s % 10]}`, { data: { data: { Name: `burst ${s}` } } })
    expect(res.status()).toBe(200)
    await new Promise(r => setTimeout(r, Math.max(0, started + (s + 1) * 1_000 - Date.now())))
  }
  // The last write shows within seconds.
  const last = await writeAndTime(page, 9, 'last write')
  const took = reads.filter(r => r.end !== null).map(r => r.end! - r.start).sort((a, b) => a - b)
  console.log(`[live-derived] ${reads.length} reads in ${Math.round((Date.now() - started) / 1000)} s, `
    + `at most ${most} at once, each ${took[0]} to ${took[took.length - 1]} ms; `
    + `the last write shown ${last.grid - last.api} ms after the API had it`)
  expect(most).toBe(1)
  // One page of rows per reload here (the tab holds the first 300): at most one a second.
  expect(reads.length).toBeLessThanOrEqual(Math.ceil((Date.now() - started) / 1_000) + 1)
  for (let i = 1; i < reads.length; i++) expect(reads[i].start - reads[i - 1].start).toBeGreaterThanOrEqual(900)
  expect(last.grid - last.api).toBeLessThan(SHOWN_WITHIN_MS)
})

// A read in a reload that never answers: the client gives it up after its time limit (30 s), the reload ends, and
// the next writes show. Held here: a reload's second read of the HTTP runs (its reconnect to running runs).
test('a reload read that never answers holds the writes after it 30 s and a rest, no longer', async ({ page }) => {
  test.setTimeout(150_000)
  await openGrid(page)
  let seen = 0
  let release: () => void = () => {}
  const released = new Promise<void>(r => { release = r })
  await page.route(/\/api\/http\/runs\?/, async route => {
    if (++seen === 2) { await released; await route.abort().catch(() => {}); return }
    await route.continue()
  })
  try {
    const first = await writeAndTime(page, 0, 'before the held read')
    await expect.poll(() => seen, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
    const heldAt = Date.now()
    const next = await writeAndTime(page, 1, 'after the held read')
    console.log(`[live-derived] held read: the write before it shown ${first.grid - first.api} ms after the API `
      + `had it; the next ${Math.round((next.grid - heldAt) / 1000)} s after the read was held`)
    // The client's 30 s limit, then a rest of at most 15 s.
    expect(next.grid - heldAt).toBeLessThan(50_000)
  } finally {
    release()
    await page.unroute(/\/api\/http\/runs\?/)
  }
})
