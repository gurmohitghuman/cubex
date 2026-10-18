import { test, expect, APIRequestContext } from '@playwright/test'
import { authedApi, importCsv } from './helpers'
import { callEveryRow, freshTreg, readDb, rowsOf, seedCsv } from './helpers-enrich'

// A waterfall lookup step and the trash. The sheet it looks in is deleted while
// the run is going (each treg call waits, so it is mid-run): the sheet goes to
// the trash, and the next row that reaches the step pauses the run ('setup')
// saying so, keeping its rows ⏳. Restored, Resume finishes every row from that
// sheet, from the same index (kept while the sheet was in the trash).
let api: APIRequestContext

test.describe.configure({ mode: 'serial' })
callEveryRow()
test.beforeAll(async () => { api = await authedApi() })
test.afterAll(async () => { await api?.dispose() })

const runStatus = async (runId: string) => (await api.get(`/api/waterfall/runs/${runId}`)).json()
const sourceIds = (sheetId: string): number[] => readDb(db =>
  db.prepare('SELECT id FROM lookup_sources WHERE sheet_id = ? ORDER BY id').pluck().all(sheetId) as number[])

test('a looked-in sheet put in the trash pauses the run; restored, Resume goes on', async () => {
  test.setTimeout(90_000)
  // "Nobody" names miss at the treg finder, so every row reaches the lookup.
  await freshTreg(api)
  const { sheetId } = await seedCsv(api,
    'Name,Website\nNobody Alpha,alpha.example\nNobody Beta,beta.example\nNobody Gamma,gamma.example')
  const t = await (await api.post('/api/tables', { data: { name: `CRM ${Date.now()}` } })).json()
  const crmId = t.sheets[0].id as string
  expect((await api.patch(`/api/tables/${t.id}/sheets/${crmId}`, { data: { name: 'Contacts' } })).ok()).toBeTruthy()
  // A table keeps at least one sheet: a second one lets Contacts go to the trash.
  expect((await api.post(`/api/tables/${t.id}/sheets`, { data: { name: 'Spare' } })).ok()).toBeTruthy()
  expect((await importCsv(api, crmId, 'Domain,Email\nalpha.example,alpha@alpha.example\n'
    + 'beta.example,beta@beta.example\ngamma.example,gamma@gamma.example', { replaceData: true })).ok()).toBeTruthy()

  const body = {
    columnName: 'Work email', resultType: 'email', fresh: true, concurrency: 1,
    inputs: [
      { key: 'full_name', label: 'Full name', source: { column: 'Name' } },
      { key: 'domain', label: 'Company domain', source: { column: 'Website' } },
    ],
    steps: [
      { id: 'sfindr1', label: 'Finder', choices: { kind: 'enrichment', toolId: 'treg.people.email.find' } },
      { id: 'slookp1', label: 'Contacts', choices: { kind: 'lookup', sheetId: crmId, matchColumn: 'Domain',
        mode: 'equals', inputKey: 'domain', returnColumn: 'Email' } },
    ],
  }
  // Test the lookup step alone first: its index is made then (the restore must find it again, not rebuild it).
  const dry = await (await api.post(`/api/waterfall/sheets/${sheetId}/dry-runs`,
    { data: { ...body, dry: { rowIds: null, only: 'slookp1' } } })).json()
  await expect.poll(async () => (await (await api.get(`/api/waterfall/dry-runs/${dry.runId}`)).json()).run.status,
    { timeout: 20_000 }).toBe('completed')
  const kept = sourceIds(crmId)
  expect(kept).toHaveLength(1)

  await freshTreg(api, { delayMs: 1_500 })
  const res = await api.post(`/api/waterfall/sheets/${sheetId}/runs`, { data: body })
  const run = await res.json()
  expect(res.ok(), JSON.stringify(run)).toBeTruthy()

  // Mid-run (the first row's treg call is waiting): Contacts goes to the trash.
  await expect.poll(async () => (await runStatus(run.runId)).status, { timeout: 10_000 }).toBe('running')
  const del = await (await api.delete(`/api/tables/${t.id}/sheets/${crmId}`)).json()
  const trashId = del.trash?.id as number
  expect(trashId).toBeTruthy()

  await expect.poll(async () => (await runStatus(run.runId)).status, { timeout: 20_000 }).toBe('paused')
  const paused = await runStatus(run.runId)
  expect(paused.pause_reason).toBe('setup')
  expect(paused.message).toContain('the sheet "Contacts" it looks in is in the trash')
  expect((await rowsOf(api, sheetId)).every(r => String(r['Work email']).startsWith('⏳'))).toBeTruthy()
  // In the trash, a new run is refused, saying why.
  const refused = await api.post(`/api/waterfall/sheets/${sheetId}/estimate`, { data: {
    columnName: 'Work email 2', resultType: 'email', fresh: true,
    inputs: [{ key: 'domain', label: 'Company domain', source: { column: 'Website' } }],
    steps: [{ choices: { kind: 'lookup', sheetId: crmId, matchColumn: 'Domain', inputKey: 'domain',
      returnColumn: 'Email' } }],
  } })
  expect(refused.status()).toBe(400)
  expect((await refused.json()).error).toContain('is in the trash')

  // Restored: Resume finishes every row from Contacts, from the index kept while it was in the trash.
  const restored = await (await api.post('/api/trash/restore', { data: { ids: [trashId] } })).json()
  expect(restored.results[0].restored).toBeTruthy()
  await freshTreg(api)
  const resumed = await api.post(`/api/waterfall/runs/${run.runId}/resume`, { data: {} })
  expect(resumed.ok(), await resumed.text()).toBeTruthy()
  await expect.poll(async () => (await runStatus(run.runId)).status, { timeout: 30_000 }).toBe('completed')
  const rows = await rowsOf(api, sheetId)
  expect(rows.map(r => [r['Work email'], r['Work email (Answered by)']])).toEqual([
    ['alpha@alpha.example', 'Contacts'], ['beta@beta.example', 'Contacts'], ['gamma@gamma.example', 'Contacts'],
  ])
  expect(sourceIds(crmId)).toEqual(kept)
})
