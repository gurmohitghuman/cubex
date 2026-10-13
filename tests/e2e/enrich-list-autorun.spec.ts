import { test, expect, APIRequestContext } from '@playwright/test'
import { authedApi } from './helpers'
import { freshTreg, rowsOf, seedCsv, startRun, waitRun } from './helpers-enrich'
import { setAutorun } from './helpers-autorun'
import { companiesCsv, destRows, peopleRun, runRest, testAndPick, waitAdded } from './helpers-list'

// Auto-run meets list runs: rows a list adds to its destination are new rows
// there, so the destination's auto-runs fill them; a list column auto-runs on
// new rows of its own sheet (and its rows' "➕" words are run markers, never
// inputs); turning it on needs its fields picked, and refuses a loop where the
// destination would add rows back.

const COMPANIES: Array<[string, string]> = [
  ['Stripe', 'stripe.com'], ['Notion', 'notion.so'], ['Figma', 'figma.com'], ['Linear', 'linear.app'],
  ['Vercel', 'vercel.com'], ['Ramp', 'ramp.com'], ['Retool', 'retool.com'],
]

// Company data on the destination, from the copied Company column (a 5-row test first).
async function companyDataOn(api: APIRequestContext, destId: string) {
  const runId = await startRun(api, destId, {
    toolId: 'treg.companies.enrich', preset: null, columnName: 'Company data', continueColumn: false,
    inputs: { name: { column: 'Company' } }, cleanDomains: true, providerOrder: [], skipProviders: [],
    stopAtFirst: false, email: null, outputs: [], rows: { mode: 'all', test: true }, conditions: [],
    maxCostPerRowUsd: null, spendLimitUsd: null, fresh: false,
  })
  await waitRun(api, runId, ['completed'])
}

async function addCompany(api: APIRequestContext, sheetId: string, company: string, website: string) {
  const row = (await (await api.post(`/api/sheets/${sheetId}/rows`, { data: { count: 1 } })).json()).rowIndexes[0]
  const res = await api.put(`/api/sheets/${sheetId}/data`, { data: { updates: [
    { rowIndex: row, columnName: 'Company', value: company }, { rowIndex: row, columnName: 'Website', value: website },
  ] } })
  expect(res.ok()).toBeTruthy()
  return row as number
}

test("rows a list adds are new rows in its sheet: that sheet's auto-run fills them", async () => {
  test.setTimeout(120_000)
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId } = await seedCsv(api, companiesCsv(COMPANIES))
  const { destId } = await testAndPick(api, sheetId, 'Prospects')
  await waitAdded(sheetId)
  await companyDataOn(api, destId)
  await setAutorun(api, destId, { column: 'Company data', enabled: true, dailyCapUsd: 2 })
  // The other 2 companies add 6 people; auto-run there fills exactly those.
  await waitRun(api, await runRest(api, sheetId, destId), ['completed'])
  await waitAdded(sheetId)
  await expect.poll(async () => (await destRows(api, destId)).slice(15).map(r => r['Company data']),
    { timeout: 30_000 }).toEqual(Array(6).fill('✅ Found'))
  // The rows that were there before turning it on stay as they were (5 from the test).
  const before = (await destRows(api, destId)).slice(0, 15).filter(r => r['Company data'] === '✅ Found')
  expect(before).toHaveLength(5)
})

test('a list column auto-runs on new rows; it needs fields and refuses a loop', async () => {
  test.setTimeout(150_000)
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId } = await seedCsv(api, companiesCsv(COMPANIES))
  // Without fields (a test only), auto-run is refused.
  const started = await (await api.post(`/api/enrich/sheets/${sheetId}/runs`, {
    data: peopleRun({ newSheetName: 'Prospects' }, { rows: { mode: 'all', status: 'any', test: true } }),
  })).json()
  await waitRun(api, started.runId, ['completed'])
  const refused = await api.put(`/api/autorun/sheets/${sheetId}/columns`,
    { data: { column: 'People', enabled: true, dailyCapUsd: 2 } })
  expect(refused.status()).toBe(400)
  expect((await refused.json()).error).toContain('Pick the fields to keep first')
  await api.post(`/api/enrich/sheets/${sheetId}/list-fields`, {
    data: { column: 'People', fields: [{ path: '$.first_name', columnName: 'First name' }] },
  })
  await waitAdded(sheetId)

  await setAutorun(api, sheetId, { column: 'People', enabled: true, dailyCapUsd: 2 })
  const row = await addCompany(api, sheetId, 'Miro', 'miro.com')
  await expect.poll(async () => (await rowsOf(api, sheetId))[row].People, { timeout: 30_000 })
    .toBe('✅ 3 rows added')
  const dest = started.destSheetId as string
  expect((await destRows(api, dest)).filter(r => r.Company === 'Miro')).toHaveLength(3)

  // A list column on the destination adding rows back here: turning on its
  // auto-run is refused while this one is on.
  const back = await startRun(api, dest, {
    toolId: 'treg.companies.search', preset: null, columnName: 'Peers', continueColumn: false,
    inputs: { name: { column: 'Company' } }, cleanDomains: true, providerOrder: [], skipProviders: [],
    stopAtFirst: false, email: null, outputs: [], rows: { mode: 'all', status: 'any', test: true }, conditions: [],
    maxCostPerRowUsd: null, spendLimitUsd: null, fresh: false,
    list: { dest: { sheetId }, provider: 'aviato', maxItems: 2, fields: null, copy: [], dedupePath: null },
  })
  await waitRun(api, back, ['completed'])
  const picked = await api.post(`/api/enrich/sheets/${dest}/list-fields`, {
    data: { column: 'Peers', fields: [{ path: '$.name', columnName: 'Company' }] },
  })
  expect(picked.ok(), await picked.text()).toBeTruthy()
  const loop = await api.put(`/api/autorun/sheets/${dest}/columns`,
    { data: { column: 'Peers', enabled: true, dailyCapUsd: 2 } })
  expect(loop.status()).toBe(400)
  expect((await loop.json()).error).toMatch(/would set off auto-run on "People" in .+, which adds rows back here/)
})
