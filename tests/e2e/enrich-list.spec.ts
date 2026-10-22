import { test, expect, Page } from '@playwright/test'
import { authedApi, BASE, importCsv } from './helpers'
import { freshTreg, rowsOf, seedCsv, waitRun } from './helpers-enrich'
import { mockTreg } from './helpers-treg'
import { companiesCsv, destRows, runRest, testAndPick, waitAdded } from './helpers-list'
import { choose, openColumnType } from './helpers-ui'

// List results into rows (plan Verification #10, UI U8): "People at a
// company" asks one provider for each row's people and adds them as rows in
// another sheet. A new list column starts with a test: its results come back,
// the fields to keep are picked from them, then the rows are added and the
// rest run. While rows go into the destination, a sort, a CSV replace or a row
// delete there waits (409), and its tab shows a dot.

const drawer = (page: Page) => page.getByTestId('enrich-drawer')
const COMPANIES: Array<[string, string]> = [
  ['Stripe', 'https://stripe.com'], ['Notion', 'notion.so'], ['Figma', 'figma.com'], ['Linear', 'linear.app'],
  ['Vercel', 'vercel.com'], ['Ramp', 'ramp.com'], ['Retool', 'retool.com'],
]

test('People at a company: test, pick the fields, add the rows, run the rest', async ({ page, context }) => {
  test.setTimeout(150_000)
  const api = await authedApi()
  await freshTreg(api)
  const { tableId, sheetId } = await seedCsv(api, companiesCsv(COMPANIES))
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })

  await openColumnType(page, 'Enrichment')
  await drawer(page).getByTestId('enrich-tool-card').filter({ hasText: 'People at a company' }).click()
  // Set up: "Add results as rows" in place of outputs; fields come after a test.
  const pane = drawer(page).getByTestId('enrich-list-rows')
  await expect(pane).toBeVisible({ timeout: 15_000 })
  await expect(drawer(page).getByTestId('enrich-list-dest-name')).toHaveValue('People')
  await expect(drawer(page).getByTestId('enrich-list-fields-later')).toBeVisible()
  await expect(drawer(page).getByTestId('enrich-run-all')).toBeDisabled()
  await expect(drawer(page).getByTestId('enrich-run-reason'))
    .toHaveText('Run on a few rows first, then pick the fields to keep.', { timeout: 15_000 })
  await drawer(page).locator('#enrich-list-max').fill('4')
  await expect(drawer(page).getByTestId('enrich-list-estimate'))
    .toHaveText('May add up to 28 rows to People (4 per row).', { timeout: 15_000 })
  // The job's own fields can fill this sheet too, from the same call (all start off).
  await drawer(page).getByRole('button', { name: /Outputs in this sheet/ }).click()
  const outputs = drawer(page).getByTestId('enrich-outputs')
  await expect(outputs.getByRole('checkbox', { checked: true })).toHaveCount(0)
  await expect(outputs).not.toContainText('People')
  await outputs.locator('li').filter({ hasText: 'Count' }).getByRole('checkbox').check()

  // The test: 5 rows' results wait for their fields.
  await drawer(page).getByTestId('enrich-run-test').click()
  await expect(page.getByTestId('enrich-test-status')).toHaveText(/^Done/, { timeout: 30_000 })
  await expect(page.getByTestId('enrich-result-row').first()).toContainText('4 results, waiting for fields')
  const picker = drawer(page).getByTestId('enrich-list-fields')
  await expect(picker).toContainText('first_name')
  await expect(picker).toContainText('in 20 of 20')
  // Keep three fields, skipping repeats by LinkedIn.
  await picker.getByRole('button', { name: 'Clear' }).click()
  for (const label of ['first_name', 'title', 'employee_linkedin']) {
    await picker.locator('li').filter({ hasText: label }).getByRole('checkbox').check()
  }
  await drawer(page).getByTestId('enrich-list-dedupe').check()
  await choose(drawer(page).getByLabel('Field to match on'), { label: 'Employee LinkedIn' })
  await drawer(page).getByTestId('enrich-list-add').click()
  await expect(drawer(page).getByTestId('enrich-list-progress')).toContainText('20 rows added to People',
    { timeout: 20_000 })

  // The rest: 2 more rows, added to the same sheet.
  await expect(drawer(page).getByTestId('enrich-run-more')).toHaveText('Run on 2 more rows')
  await drawer(page).getByTestId('enrich-run-more').click()
  const dialog = page.getByRole('dialog').filter({ hasText: 'Run the enrichment' })
  await dialog.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.getByTestId('enrich-view-results')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('enrich-run-list')).toHaveText('8 rows added to People.', { timeout: 15_000 })

  const source = await rowsOf(api, sheetId)
  // The status column is named after the job.
  expect(source.map(r => r['People at a company'])).toEqual(Array(7).fill('✅ 4 rows added'))
  expect(source.map(r => r.Count)).toEqual(Array(7).fill('4'))
  const tables = await (await api.get(`/api/tables/${tableId}`)).json()
  const dest = tables.sheets.find((s: { name: string }) => s.name === 'People')
  const people = await destRows(api, dest.id)
  expect(people).toHaveLength(28)
  // The copied column (the mapped input) and the three kept fields, under their names.
  expect(Object.keys(people[0]).sort()).toEqual(['Employee LinkedIn', 'First name', 'Title', 'Website'])
  expect(people[0].Website).toBe('https://stripe.com')
  expect(people[0]['First name']).toBe('Ada')
})

test('the destination waits while rows are added; its tab shows a dot', async ({ page, context }) => {
  test.setTimeout(120_000)
  const api = await authedApi()
  await freshTreg(api)
  const { tableId, sheetId } = await seedCsv(api, companiesCsv(COMPANIES))
  const { destId } = await testAndPick(api, sheetId, 'Prospects')
  await waitAdded(sheetId)
  expect(await destRows(api, destId)).toHaveLength(15)

  await mockTreg.set({ delayMs: 1500 })
  const runId = await runRest(api, sheetId, destId)
  await expect.poll(async () => (await api.get(`/api/enrich/runs/${runId}`).then(r => r.json())).status,
    { timeout: 10_000 }).toBe('running')
  const gen = (await (await api.get(`/api/sheets/${destId}`)).json()).sheet.row_generation
  const sort = await api.post(`/api/sheets/${destId}/sort`, { data: { column: 'First name', direction: 'asc' } })
  expect(sort.status()).toBe(409)
  expect((await sort.json()).error).toBe('Rows are being added to this sheet by People in Sheet1. '
    + 'Try again when that finishes.')
  const del = await api.post(`/api/sheets/${destId}/rows/bulk-delete`,
    { data: { rowIndices: [0], rowGeneration: gen } })
  expect(del.status()).toBe(409)
  const replace = await importCsv(api, destId, 'A\n1', { replaceData: true, filename: 'r.csv' })
  expect(replace.status()).toBe(409)
  // The tab bar's dot.
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.getByTestId('sheet-tab-adding')).toBeVisible({ timeout: 15_000 })

  await waitRun(api, runId, ['completed'], 60_000)
  await mockTreg.set({ delayMs: 0 })
  await waitAdded(sheetId)
  await expect(page.getByTestId('sheet-tab-adding')).toHaveCount(0, { timeout: 30_000 })
  expect(await destRows(api, destId)).toHaveLength(21)
  // Done: the sort goes through.
  const after = await api.post(`/api/sheets/${destId}/sort`, { data: { column: 'First name', direction: 'asc' } })
  expect(after.ok()).toBeTruthy()
})
