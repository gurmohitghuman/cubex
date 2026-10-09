import { test, expect } from '@playwright/test'
import { authedApi } from './helpers'
import { freshTreg, rowsOf, seedCsv, waitRun } from './helpers-enrich'
import { companiesCsv, destRows, runRest, testAndPick } from './helpers-list'

// The row limit meets a list job (plan Verification #10): a full destination
// pauses the run before it buys more results, the results already bought wait
// for room (their row says so), Resume is refused while the sheet is still
// full, and deleting rows there lets the waiting rows in. The default limit is
// a million rows, so this runs on its own with a small one:
//   MAX_ROWS_PER_SHEET=60 E2E_SPEC=tests/e2e/enrich-list-cap.spec.ts scripts/e2e-harness.sh
const CAP = Number(process.env.MAX_ROWS_PER_SHEET ?? 1_000_000)
const COMPANIES: Array<[string, string]> = Array.from({ length: 12 }, (_, i) => [`Co ${i + 1}`, `co${i + 1}.example`])

test('a full destination pauses the run; deleting rows there lets the rest in', async () => {
  test.skip(CAP !== 60, 'needs MAX_ROWS_PER_SHEET=60 (see the comment at the top)')
  test.setTimeout(120_000)
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId } = await seedCsv(api, companiesCsv(COMPANIES))
  const { destId } = await testAndPick(api, sheetId, 'Prospects')
  await expect.poll(async () => (await destRows(api, destId)).length).toBe(15)
  // 35 more rows: 50 of 60. The other 7 companies would add 21.
  expect((await api.post(`/api/sheets/${destId}/rows`, { data: { count: 35 } })).ok()).toBeTruthy()
  const runId = await runRest(api, sheetId, destId)
  const paused = await waitRun(api, runId, ['paused'], 30_000)
  expect(paused.pauseReason).toBe('dest_full')
  expect(paused.message).toBe('Prospects is full (60 rows). Delete rows there, then Resume.')
  await expect.poll(async () => (await rowsOf(api, sheetId)).some(r => /waiting for room in Prospects/.test(r.People)),
    { timeout: 15_000 }).toBe(true)
  const resume = await api.post(`/api/enrich/runs/${runId}/resume`, { data: {} })
  expect(resume.status()).toBe(409)

  // Room: delete the 35 blank rows (waiting rows never hold the sheet).
  const all = (await (await api.get(`/api/sheets/${destId}?limit=1000&offset=0`)).json())
  const blank = all.data.rows.filter((r: { data: Record<string, string> }) => !r.data['First name'])
    .map((r: { rowIndex: number }) => r.rowIndex)
  const del = await api.post(`/api/sheets/${destId}/rows/bulk-delete`,
    { data: { rowIndices: blank, rowGeneration: all.sheet.row_generation } })
  expect(del.ok(), await del.text()).toBeTruthy()
  // The waiting results go in, then Resume carries the run on.
  await expect.poll(async () => (await rowsOf(api, sheetId)).filter(r => /waiting for room/.test(r.People)).length,
    { timeout: 15_000 }).toBe(0)
  expect((await api.post(`/api/enrich/runs/${runId}/resume`, { data: {} })).ok()).toBeTruthy()
  await waitRun(api, runId, ['completed'], 30_000)
  await expect.poll(async () => (await destRows(api, destId)).length, { timeout: 15_000 }).toBe(36)
  expect((await rowsOf(api, sheetId)).every(r => r.People === '✅ 3 rows added')).toBe(true)
})
