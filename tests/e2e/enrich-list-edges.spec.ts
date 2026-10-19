import { test, expect } from '@playwright/test'
import path from 'path'
import { createRequire } from 'module'
import { v4 as uuid } from 'uuid'
import { authedApi, BASE, assertTestDb } from './helpers'
import { freshTreg, readDb, rowsOf, seedCsv, startRun, waitRun } from './helpers-enrich'
import { mockTreg } from './helpers-treg'
import { companiesCsv, destRows, peopleRun, PEOPLE_FIELDS, runRest, testAndPick, waitAdded } from './helpers-list'

// List results into rows, the edge cases (plan Verification #25): results a
// restart left in the journal are added once; a rerun of a source row replaces
// the rows it added; "skip results already added" skips them; a new run on
// the column waits while rows are still being added (here held by a run on
// the destination, which a replacement waits for); a row whose results wait
// isn't "processing"; deleting the destination cancels the run.

const require = createRequire(import.meta.url)
const COMPANIES: Array<[string, string]> = [
  ['Stripe', 'stripe.com'], ['Notion', 'notion.so'], ['Figma', 'figma.com'], ['Linear', 'linear.app'],
  ['Vercel', 'vercel.com'], ['Ramp', 'ramp.com'], ['Retool', 'retool.com'],
]
const COL = 'People'

function writeDb(fn: (db: any) => void) {
  const Database = require(path.join(process.cwd(), 'node_modules/better-sqlite3'))
  const db = new Database(assertTestDb(process.env.DB_PATH))
  try { db.pragma('busy_timeout = 5000'); fn(db) } finally { db.close() }
}
const provenance = (sourceRowId: string) => readDb(db => db.prepare(
  'SELECT dest_row_id FROM enrichment_list_rows WHERE source_row_id = ? ORDER BY dest_row_id',
).all(sourceRowId).map((r: { dest_row_id: string }) => r.dest_row_id)) as string[]
const sourceRowIds = (sheetId: string) => readDb(db => db.prepare(
  'SELECT id FROM rows WHERE sheet_id = ? ORDER BY row_index',
).all(sheetId).map((r: { id: string }) => r.id)) as string[]

test('results a restart left are added once; a rerun replaces a row\'s rows; repeats are skipped', async () => {
  test.setTimeout(120_000)
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId } = await seedCsv(api, companiesCsv([...COMPANIES, ['Stripe again', 'stripe.com']]))
  const { runId, destId } = await testAndPick(api, sheetId, 'Prospects', { dedupe: true })
  await waitAdded(sheetId)
  const ids = sourceRowIds(sheetId)
  expect(await destRows(api, destId)).toHaveLength(15)

  // A journal row a crash left pending (the worker wrote it, nothing added it yet).
  writeDb(db => {
    db.prepare(`INSERT INTO enrichment_list_items (id, user_id, run_id, source_sheet_id, source_row_id,
      dest_sheet_id, items_json) SELECT ?, user_id, ?, ?, ?, ?, ? FROM rows WHERE id = ?`)
      .run(uuid(), runId, sheetId, ids[6], destId,
        JSON.stringify({ items: [{ first_name: 'Restart', employee_linkedin: 'https://r.example' }], copy: {} }),
        ids[6])
    db.prepare(`UPDATE rows SET data = json_set(data, '$."${COL}"', '➕ Adding 1 row…') WHERE id = ?`).run(ids[6])
  })
  await waitAdded(sheetId)
  await new Promise(r => setTimeout(r, 1500))   // a few more drain rounds
  expect((await destRows(api, destId)).filter(r => r['First name'] === 'Restart')).toHaveLength(1)
  expect((await rowsOf(api, sheetId))[6][COL]).toBe('✅ 1 row added')

  // A rerun of row 1 (Stripe): its 3 rows are replaced, the sheet keeps 16.
  const before = provenance(ids[0])
  const gen = (await (await api.get(`/api/sheets/${sheetId}`)).json()).sheet.row_generation
  const rerun = await api.post(`/api/enrich/sheets/${sheetId}/reruns`,
    { data: { column: COL, mode: 'selected', status: 'any', rowIndexes: [0], rowGeneration: gen } })
  expect(rerun.ok(), await rerun.text()).toBeTruthy()
  await waitRun(api, (await rerun.json()).runId, ['completed'])
  await waitAdded(sheetId)
  const replaced = provenance(ids[0])
  expect(replaced).toHaveLength(3)
  expect(replaced.some(id => before.includes(id))).toBe(false)
  expect(await destRows(api, destId)).toHaveLength(16)

  // The rest: Ramp adds 3; "Stripe again" finds the same people, skipped as already there.
  const rest = await runRest(api, sheetId, destId, { dedupePath: '$.employee_linkedin' })
  await waitRun(api, rest, ['completed'])
  await waitAdded(sheetId)
  expect((await rowsOf(api, sheetId))[7][COL]).toBe('✅ All 3 already there')
  expect(await destRows(api, destId)).toHaveLength(19)
})

test('a new run on the column waits while rows are added (a run on the destination holds them)', async () => {
  test.setTimeout(150_000)
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId } = await seedCsv(api, companiesCsv(COMPANIES))
  const { destId } = await testAndPick(api, sheetId, 'Prospects')
  await waitAdded(sheetId)
  // A slow enrichment on the destination's rows (company data from the copied Company).
  await mockTreg.set({ delayMs: 2000 })
  const destRun = await startRun(api, destId, {
    toolId: 'treg.companies.enrich', preset: null, columnName: 'Company data', continueColumn: false,
    inputs: { name: { column: 'Company' } }, cleanDomains: true, providerOrder: [], skipProviders: [],
    stopAtFirst: false, email: null, outputs: [], rows: { mode: 'all', test: false }, conditions: [],
    maxCostPerRowUsd: null, spendLimitUsd: null, fresh: false,
  })
  await expect.poll(async () => (await api.get(`/api/enrich/runs/${destRun}`).then(r => r.json())).status)
    .toBe('running')
  // Row 1 again: its new results must replace its rows, which waits for that run.
  const gen = (await (await api.get(`/api/sheets/${sheetId}`)).json()).sheet.row_generation
  const again = await api.post(`/api/enrich/sheets/${sheetId}/reruns`,
    { data: { column: COL, mode: 'selected', status: 'any', rowIndexes: [0], rowGeneration: gen } })
  await waitRun(api, (await again.json()).runId, ['completed'])
  expect(readDb(db => db.prepare(`SELECT COUNT(*) AS n FROM enrichment_list_items WHERE source_sheet_id = ?
    AND status = 'pending' AND wait_reason IS NULL`).get(sheetId).n)).toBe(1)
  const refused = await api.post(`/api/enrich/sheets/${sheetId}/reruns`,
    { data: { column: COL, mode: 'all', status: 'any' } })
  expect(refused.status()).toBe(409)
  expect((await refused.json()).error)
    .toBe('Rows from this column are still being added to Prospects. Try again when that finishes.')
  await mockTreg.set({ delayMs: 0 })
  await waitRun(api, destRun, ['completed'], 60_000)
  await waitAdded(sheetId)
  expect((await rowsOf(api, sheetId))[0][COL]).toBe('✅ 3 rows added')
})

test('a row whose results wait for fields is not processing', async ({ page, context }) => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await freshTreg(api)
  const { tableId, sheetId } = await seedCsv(api, companiesCsv(COMPANIES))
  const started = await (await api.post(`/api/enrich/sheets/${sheetId}/runs`, {
    data: peopleRun({ newSheetName: 'Prospects' }, { rows: { mode: 'all', status: 'any', test: true } }),
  })).json()
  await waitRun(api, started.runId, ['completed'])
  expect((await rowsOf(api, sheetId))[0][COL]).toBe('➕ 3 results, waiting for fields')
  // The column's "rows not enriched yet" are the 2 the test didn't take.
  const est = await (await api.post(`/api/enrich/sheets/${sheetId}/reruns`,
    { data: { column: COL, mode: 'all', status: 'not_enriched', estimateOnly: true } })).json()
  expect(est.estimate.rows).toBe(2)
  expect(est.estimate.addsRowsTo).toEqual({ name: 'Prospects', addUpTo: 6 })
  // Waiting results never hold the destination, and the grid shows no spinner.
  const sort = await api.post(`/api/sheets/${started.destSheetId}/sort`,
    { data: { column: 'Company', direction: 'asc' } })
  expect(sort.ok(), await sort.text()).toBeTruthy()
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  const cell = page.locator(`.ag-row[row-index="0"] [col-id]`).filter({ hasText: 'waiting for fields' }).first()
  await expect(cell).toBeVisible({ timeout: 15_000 })
  await expect(cell.locator('.animate-spin')).toHaveCount(0)
  // Deleting this sheet would drop them: the confirm says how many and where.
  const notAdded = (await (await api.get(`/api/enrich/sheets/${sheetId}/results-not-added`)).json()).notAdded
  expect(notAdded.sheets).toEqual(['Prospects'])
  await page.getByRole('button', { name: /^Sheet options for / }).first().click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await expect(page.getByRole('dialog')).toContainText(
    `${notAdded.results} results from it haven't been added to Prospects yet. They're dropped, and restoring `
      + "the sheet doesn't bring them back.")
  await page.getByRole('button', { name: 'Cancel' }).click()
  // A full run without fields is refused; picking them adds the rows.
  const full = await api.post(`/api/enrich/sheets/${sheetId}/runs`, {
    data: peopleRun({ sheetId: started.destSheetId }, { continueColumn: true,
      rows: { mode: 'all', status: 'not_enriched', test: false } }),
  })
  expect(full.status()).toBe(400)
  expect((await full.json()).error).toContain('Pick the fields to keep first')
  await api.post(`/api/enrich/sheets/${sheetId}/list-fields`, { data: { column: COL, fields: PEOPLE_FIELDS } })
  await waitAdded(sheetId)
  expect(await destRows(api, started.destSheetId)).toHaveLength(15)
})

test('deleting the destination cancels the run and says so on its rows', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await freshTreg(api)
  const { tableId, sheetId } = await seedCsv(api, companiesCsv(COMPANIES))
  const { destId } = await testAndPick(api, sheetId, 'Prospects')
  await waitAdded(sheetId)
  await mockTreg.set({ delayMs: 2500 })
  const runId = await runRest(api, sheetId, destId)
  await expect.poll(async () => (await api.get(`/api/enrich/runs/${runId}`).then(r => r.json())).status)
    .toBe('running')
  const del = await api.delete(`/api/tables/${tableId}/sheets/${destId}`)
  expect(del.ok(), await del.text()).toBeTruthy()
  expect((await waitRun(api, runId, ['cancelled'])).status).toBe('cancelled')
  await mockTreg.set({ delayMs: 0 })
  // Its rows don't stay ⏳: they read as not run yet (empty).
  await expect.poll(async () => (await rowsOf(api, sheetId)).slice(5).map(r => r[COL] ?? ''), { timeout: 15_000 })
    .toEqual(['', ''])
})
