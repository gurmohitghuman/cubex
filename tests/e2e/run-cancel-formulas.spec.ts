import { test, expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test'
import { authedApi, BASE, getSheet } from './helpers'
import { sheetWith } from './helpers-setups'
import { Receiver } from './helpers-receiver'

// Cancelling a run mid-way clears the ⏳ cells it left: a row it hadn't
// reached gets back what its cells held before the run (nothing, on a first
// run), a row it answered keeps its new answer, and a formula column reading
// them follows, in the open grid too. An HTTP API column asks the spec's
// receiver, which holds answers back, so the cancel lands while those rows are
// still in flight and nothing it held back is written.

const NAMES = ['ada', 'bob', 'cy']
const FORMULA = '{{Who}} ? "found " + {{Who}} : "nobody"'
const NOBODY = NAMES.map(() => 'nobody')
const rx = new Receiver()
test.beforeAll(() => rx.start())
test.afterAll(() => rx.stop())

const column = async (api: APIRequestContext, sheetId: string, name: string) =>
  (await getSheet(api, sheetId)).data.rows.map((r: any) => r.data[name] ?? '')
const runStatus = async (api: APIRequestContext, runId: string) =>
  (await (await api.get(`/api/http/jobs/${runId}`)).json()).status as string
const answers = (path: string, suffix: string) => {
  for (const n of NAMES) {
    rx.on(`/${path}/${n}`, { status: 200, body: JSON.stringify({ who: n.toUpperCase() + suffix }) })
  }
}
// Rows whose request on `path` came after `asked` (each name's count before).
const asking = (path: string, asked: number[]) =>
  NAMES.filter((n, i) => rx.hitsOn(`/${path}/${n}`).length > asked[i]).length
const askedSoFar = (path: string) => NAMES.map(n => rx.hitsOn(`/${path}/${n}`).length)

// The Lookup column asks `/<path>/<Name>` and puts the answer's `who` in Who. A POST, so no answer comes from
// the cache: every row asks the receiver.
async function startLookup(api: APIRequestContext, sheetId: string, path: string): Promise<string> {
  const start = await api.post('/api/http/run', { data: { sheetId, masterColumnName: 'Lookup', config: {
    requestConfig: { method: 'POST', url: rx.url(`/${path}/{{Name}}`), headers: { 'Content-Type': 'application/json' },
      body: '{}' },
    responseMapping: [{ columnName: 'Who', jsonPath: '$.who' }],
  } } })
  expect(start.ok(), await start.text()).toBeTruthy()
  return (await start.json()).runId as string
}
// Seen, a formula reading Who: added, or saved again (worked out from every row again).
async function saveFormula(api: APIRequestContext, sheetId: string) {
  const res = await api.post(`/api/sheets/${sheetId}/formula-columns`, { data: { column: 'Seen', formula: FORMULA } })
  expect(res.ok(), await res.text()).toBeTruthy()
}
async function cancel(api: APIRequestContext, runId: string) {
  const res = await api.post(`/api/http/jobs/${runId}/control`, { data: { action: 'cancel' } })
  expect(res.ok(), await res.text()).toBeTruthy()
}
async function openGrid(page: Page, context: BrowserContext, api: APIRequestContext, tableId: string) {
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  return (i: number) => page.locator(`.ag-center-cols-container .ag-row[row-index="${i}"]`)
}
// The answers held back are dropped, not written. settled() returns once the receiver has answered, maybe
// before the worker read those answers: watch the cells for 2 s more, failing on the first other value.
async function staysFor2s(api: APIRequestContext, sheetId: string, who: string[], seen: string[]) {
  await rx.settled()
  for (const end = Date.now() + 2_000; Date.now() < end;) {
    expect(await column(api, sheetId, 'Who')).toEqual(who)
    expect(await column(api, sheetId, 'Seen')).toEqual(seen)
    await new Promise(r => setTimeout(r, 200))
  }
}

test('a first run cancelled in flight leaves its cells empty, the formula nobody', async ({ page, context }) => {
  test.setTimeout(120_000)
  const api = await authedApi()
  const { tableId, sheetId } = await sheetWith(api, null, NAMES.map(Name => ({ Name })))
  answers('first', '')
  const release = rx.hold()
  try {
    const asked = askedSoFar('first')
    const runId = await startLookup(api, sheetId, 'first')
    await expect.poll(() => asking('first', asked), { timeout: 30_000 }).toBe(NAMES.length)
    expect(await column(api, sheetId, 'Who')).toEqual(NAMES.map(() => '⏳ Processing...'))
    await saveFormula(api, sheetId)
    await expect.poll(() => column(api, sheetId, 'Seen'), { timeout: 30_000 }).toEqual(NOBODY)
    const row = await openGrid(page, context, api, tableId)
    await expect(row(0).locator('.cube-cell-spinner').first()).toBeVisible({ timeout: 15_000 })
    await cancel(api, runId)
    // Nothing was there before the run: the cells it hadn't reached are empty.
    await expect.poll(() => column(api, sheetId, 'Who'), { timeout: 15_000 }).toEqual(['', '', ''])
    expect(await column(api, sheetId, 'Lookup')).toEqual(['', '', ''])
    await expect.poll(() => column(api, sheetId, 'Seen'), { timeout: 15_000 }).toEqual(NOBODY)
    await expect(row(0).locator('.cube-cell-spinner')).toHaveCount(0, { timeout: 15_000 })
    await expect(row(0)).toContainText('nobody')
    await expect(row(0)).not.toContainText('found')
    expect(await runStatus(api, runId)).toBe('cancelled')
  } finally {
    release()
  }
  await staysFor2s(api, sheetId, ['', '', ''], NOBODY)
  await api.dispose()
})

test('a rerun cancelled with one row answered: that row keeps its new answer, the others get theirs back, and a ' +
  'formula follows both', async ({ page, context }) => {
  test.setTimeout(120_000)
  const api = await authedApi()
  const { tableId, sheetId } = await sheetWith(api, null, NAMES.map(Name => ({ Name })))
  answers('who', '')
  const first = await startLookup(api, sheetId, 'who')
  await expect.poll(() => runStatus(api, first), { timeout: 30_000 }).toBe('completed')
  expect(await column(api, sheetId, 'Who')).toEqual(['ADA', 'BOB', 'CY'])
  const lookup = await column(api, sheetId, 'Lookup')
  expect(lookup.every((v: string) => v !== '' && !v.includes('⏳'))).toBeTruthy()
  await saveFormula(api, sheetId)
  await expect.poll(() => column(api, sheetId, 'Seen'), { timeout: 30_000 })
    .toEqual(['found ADA', 'found BOB', 'found CY'])
  const row = await openGrid(page, context, api, tableId)
  await expect(row(1)).toContainText('found BOB', { timeout: 15_000 })

  // New answers; bob's and cy's held back, so the rerun answers ada and is cancelled with the others in flight.
  answers('who', ' 2')
  const release = rx.hold(['/who/bob', '/who/cy'])
  try {
    const asked = askedSoFar('who')
    const rerun = await api.post('/api/http/rerun', { data: { sheetId, masterColumnName: 'Lookup' } })
    expect(rerun.ok(), await rerun.text()).toBeTruthy()
    const second = (await rerun.json()).runId as string
    await expect.poll(() => asking('who', asked), { timeout: 30_000 }).toBe(NAMES.length)
    await expect.poll(() => column(api, sheetId, 'Who'), { timeout: 30_000 })
      .toEqual(['ADA 2', '⏳ Processing...', '⏳ Processing...'])
    // The formula saved again while the run goes reads bob's and cy's ⏳ as empty.
    await saveFormula(api, sheetId)
    await expect.poll(() => column(api, sheetId, 'Seen'), { timeout: 30_000 })
      .toEqual(['found ADA 2', 'nobody', 'nobody'])
    await expect(row(1)).toContainText('nobody', { timeout: 15_000 })
    await cancel(api, second)
    await expect.poll(() => column(api, sheetId, 'Who'), { timeout: 15_000 }).toEqual(['ADA 2', 'BOB', 'CY'])
    expect(await column(api, sheetId, 'Lookup')).toEqual(lookup)
    // Nothing else wrote these rows: the formula followed the cancel's clear.
    await expect.poll(() => column(api, sheetId, 'Seen'), { timeout: 15_000 })
      .toEqual(['found ADA 2', 'found BOB', 'found CY'])
    await expect(row(1)).toContainText('found BOB', { timeout: 15_000 })
    await expect(row(2)).toContainText('found CY', { timeout: 15_000 })
    await expect(row(0)).toContainText('found ADA 2', { timeout: 15_000 })
    for (const i of [0, 1, 2]) await expect(row(i).locator('.cube-cell-spinner')).toHaveCount(0)
    expect(await runStatus(api, second)).toBe('cancelled')
  } finally {
    release()
  }
  await staysFor2s(api, sheetId, ['ADA 2', 'BOB', 'CY'], ['found ADA 2', 'found BOB', 'found CY'])
  await api.dispose()
})
