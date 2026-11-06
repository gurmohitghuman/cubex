import { test, expect, type APIRequestContext } from '@playwright/test'
import { authedApi, BASE, getSheet } from './helpers'
import { sheetWith } from './helpers-setups'
import { Receiver } from './helpers-receiver'

// Cancelling a run mid-way clears the ⏳ cells it left, and the answer those
// cells held before it is gone: a formula column reading it works those rows
// out again by itself, in the open grid too. An HTTP API column asks the
// spec's receiver; the second run's answers are held back, so the cancel
// lands while every row is still in flight and nothing it asked is written.

const NAMES = ['ada', 'bob', 'cy']
const FORMULA = '{{Who}} ? "found " + {{Who}} : "nobody"'
const rx = new Receiver()
test.beforeAll(() => rx.start())
test.afterAll(() => rx.stop())

const column = async (api: APIRequestContext, sheetId: string, name: string) =>
  (await getSheet(api, sheetId)).data.rows.map((r: any) => r.data[name] ?? '')
const runStatus = async (api: APIRequestContext, runId: string) =>
  (await (await api.get(`/api/http/jobs/${runId}`)).json()).status as string

test('a formula reading a cancelled run\'s answers follows the cleared cells', async ({ page, context }) => {
  test.setTimeout(120_000)
  const api = await authedApi()
  const { tableId, sheetId } = await sheetWith(api, null, NAMES.map(Name => ({ Name })))
  for (const n of NAMES) rx.on(`/who/${n}`, { status: 200, body: JSON.stringify({ who: n.toUpperCase() }) })
  // A POST, so no answer comes from the cache: every row asks the receiver.
  const start = await api.post('/api/http/run', { data: { sheetId, masterColumnName: 'Lookup', config: {
    requestConfig: { method: 'POST', url: rx.url('/who/{{Name}}'), headers: { 'Content-Type': 'application/json' },
      body: '{}' },
    responseMapping: [{ columnName: 'Who', jsonPath: '$.who' }],
  } } })
  expect(start.ok(), await start.text()).toBeTruthy()
  const first = (await start.json()).runId as string
  await expect.poll(() => runStatus(api, first), { timeout: 30_000 }).toBe('completed')
  expect(await column(api, sheetId, 'Who')).toEqual(['ADA', 'BOB', 'CY'])

  const formula = await api.post(`/api/sheets/${sheetId}/formula-columns`,
    { data: { column: 'Seen', formula: FORMULA } })
  expect(formula.ok(), await formula.text()).toBeTruthy()
  await expect.poll(() => column(api, sheetId, 'Seen'), { timeout: 30_000 })
    .toEqual(['found ADA', 'found BOB', 'found CY'])

  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  const row0 = page.locator('.ag-center-cols-container .ag-row[row-index="0"]')
  await expect(row0).toContainText('found ADA', { timeout: 15_000 })

  // Run the column again with every answer held back, then cancel it mid-way.
  const release = rx.hold()
  try {
    const asked = NAMES.map(n => rx.hitsOn(`/who/${n}`).length)
    const rerun = await api.post('/api/http/rerun', { data: { sheetId, masterColumnName: 'Lookup' } })
    expect(rerun.ok(), await rerun.text()).toBeTruthy()
    const second = (await rerun.json()).runId as string
    await expect.poll(() => NAMES.filter((n, i) => rx.hitsOn(`/who/${n}`).length > asked[i]).length,
      { timeout: 30_000 }).toBe(NAMES.length)
    expect(await column(api, sheetId, 'Who')).toEqual(NAMES.map(() => '⏳ Processing...'))
    const cancel = await api.post(`/api/http/jobs/${second}/control`, { data: { action: 'cancel' } })
    expect(cancel.ok(), await cancel.text()).toBeTruthy()
    await expect.poll(() => column(api, sheetId, 'Who'), { timeout: 15_000 }).toEqual(['', '', ''])
    // Nothing else wrote these rows: the formula followed the cancel's clear.
    await expect.poll(() => column(api, sheetId, 'Seen'), { timeout: 15_000 })
      .toEqual(['nobody', 'nobody', 'nobody'])
    await expect(row0).toContainText('nobody', { timeout: 15_000 })
    await expect(row0).not.toContainText('found')
    expect(await runStatus(api, second)).toBe('cancelled')
  } finally {
    release()
  }
  // The answers held back are dropped, not written. settled() returns once the receiver has answered, maybe
  // before the worker read those answers: watch the cells for 2 s more, failing on the first other value.
  await rx.settled()
  for (const end = Date.now() + 2_000; Date.now() < end;) {
    expect(await column(api, sheetId, 'Who')).toEqual(['', '', ''])
    expect(await column(api, sheetId, 'Seen')).toEqual(['nobody', 'nobody', 'nobody'])
    await new Promise(r => setTimeout(r, 200))
  }
  await api.dispose()
})
