import { test, expect, Page, APIRequestContext } from '@playwright/test'
import { authedApi, BASE } from './helpers'
import { mockTreg } from './helpers-treg'
import {
  callEveryRow, expectSettledBilledOnce, freshTreg, rowsOf, runIdsOf, runStatus, seedLeadRows, startRun, waitRun,
} from './helpers-enrich'

// An enrichment's status column in the grid (plan U6): its own icon, ✅ ⏭️ ❌
// tints, and Enrichment Actions in the column menu, each run going through the
// enrichment start with a confirm that quotes the rows and the estimate (the
// plain HTTP rerun refuses enrichment columns). Edit Enrichment opens Set up
// prefilled from the column's newest run. The confirm's estimate creates nothing.

const COL = 'Find email'
callEveryRow()
const LEADS = [
  { Name: 'Ada One', Website: 'good1.example' }, { Name: 'Bo Two', Website: 'bad.example' },
  { Name: 'Cy Three', Website: 'good3.example' }, { Name: 'Di Four', Website: 'gone.example' },
  { Name: 'Ed Five', Website: 'good5.example' },
]
const findRun = (over: Record<string, unknown> = {}) => ({
  toolId: 'treg.people.email.find', preset: null, columnName: COL, continueColumn: false,
  inputs: { full_name: { column: 'Name' }, domain: { column: 'Website' } }, cleanDomains: true,
  providerOrder: [], skipProviders: [], stopAtFirst: false, email: null,
  outputs: [{ key: 'email', path: '$.output.email', columnName: 'Email' }],
  rows: { mode: 'all', test: false }, conditions: [], maxCostPerRowUsd: null, spendLimitUsd: null, fresh: false,
  ...over,
})
const statuses = async (api: APIRequestContext, sheetId: string) => (await rowsOf(api, sheetId)).map(r => r[COL] ?? '')
const cell = (page: Page, row: number) => page.locator(`.ag-row[row-index="${row}"] .ag-cell[col-id]`)
  .filter({ hasText: /✅|⏭️|❌/ }).first()

async function openMenu(page: Page) {
  await page.locator('.ag-header-cell').filter({ hasText: COL }).first().locator('.ag-header-cell-text').first().click()
  await expect(page.getByRole('menu')).toBeVisible()
}
async function menuRun(page: Page, item: RegExp, title: string, expectText: string | RegExp) {
  await openMenu(page)
  await page.getByRole('menuitem', { name: item }).click()
  const dialog = page.getByRole('dialog').filter({ hasText: title })
  await expect(dialog).toContainText(expectText, { timeout: 15_000 })
  return dialog
}
async function newestRunDone(api: APIRequestContext, sheetId: string, before: number) {
  await expect.poll(() => runIdsOf(sheetId).length, { timeout: 15_000 }).toBe(before + 1)
  const id = runIdsOf(sheetId)[before]
  return waitRun(api, id, ['completed'])
}

test('the column menu runs, retries, edits and stops an enrichment column', async ({ page, context }) => {
  test.setTimeout(150_000)
  const api = await authedApi()
  await freshTreg(api, { badDomains: ['bad.example'], findMisses: { gone: 99 } })
  const { tableId, sheetId } = await seedLeadRows(api, LEADS)
  await waitRun(api, await startRun(api, sheetId, findRun()), ['completed'])
  expect(await statuses(api, sheetId))
    .toEqual(['✅ Found', expect.stringMatching(/^❌ /), '✅ Found', '⏭️ Not found', '✅ Found'])
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })

  // The status column: its icon, no HTTP 🔗; its output keeps 📎; cell tints.
  await expect(page.getByTestId('enrich-status-icon')).toHaveCount(1)
  await expect(page.locator('.ag-header-cell').filter({ hasText: COL }).first()).not.toContainText('🔗')
  await expect(page.locator('.ag-header-cell').filter({ hasText: '📎 Email' })).toHaveCount(1)
  await expect(cell(page, 0)).toHaveCSS('background-color', 'rgb(240, 253, 244)')
  await expect(cell(page, 1)).toHaveCSS('background-color', 'rgb(254, 242, 242)')
  await expect(cell(page, 3)).toHaveCSS('background-color', 'rgb(248, 250, 252)')

  await openMenu(page)
  const menu = page.getByRole('menu')
  const items = ['Enrichment Actions', 'Run Rows Not Enriched', 'Retry Failed Rows', 'Run All Rows Again',
    'Edit Enrichment']
  for (const t of items) await expect(menu).toContainText(t)
  await expect(menu).not.toContainText('HTTP API Actions')
  await page.keyboard.press('Escape')

  // Retry Failed Rows: only the ❌ row, once treg takes its domain.
  await mockTreg.set({ badDomains: [] })
  let before = runIdsOf(sheetId).length
  let dialog = await menuRun(page, /Retry Failed Rows/, 'Retry failed rows', '1 row that failed')
  await expect(dialog).toContainText(/Estimated \$[\d.]+ to \$[\d.]+/)
  await dialog.getByRole('button', { name: 'Run', exact: true }).click()
  expect((await newestRunDone(api, sheetId, before)).totalRows).toBe(1)
  expect((await statuses(api, sheetId))[1]).toBe('✅ Found')

  // Run Selected Rows: the selected row only, whatever its status.
  await mockTreg.set({ findMisses: {} })
  await page.locator('.ag-row[row-index="3"] input[type="checkbox"]').first().check()
  before = runIdsOf(sheetId).length
  dialog = await menuRun(page, /Run Selected Rows \(1\)/, 'Run selected rows', '1 selected row')
  await dialog.getByRole('button', { name: 'Run', exact: true }).click()
  expect((await newestRunDone(api, sheetId, before)).totalRows).toBe(1)
  expect((await statuses(api, sheetId))[3]).toBe('✅ Found')

  // Nothing left to run: the confirm only says so.
  const none = `Every row in ${COL} is enriched already.`
  dialog = await menuRun(page, /Run Rows Not Enriched/, 'Run rows not enriched', none)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()

  // Run All Rows Again: every row, results replaced.
  before = runIdsOf(sheetId).length
  dialog = await menuRun(page, /Run All Rows Again/, 'Run all rows again', 'all 5 rows again')
  await expect(dialog).toContainText('replaced')
  await dialog.getByRole('button', { name: 'Run', exact: true }).click()
  expect((await newestRunDone(api, sheetId, before)).totalRows).toBe(5)

  // Edit Enrichment: Set up on the column, prefilled from its newest run.
  await openMenu(page)
  await page.getByRole('menuitem', { name: /Edit Enrichment/ }).click()
  await expect(page.getByText('Edit enrichment', { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('#enrich-column-name')).toHaveValue(COL, { timeout: 15_000 })
  await expect(page.getByTestId('enrich-rows-status')).toContainText('Rows not enriched yet (0)')
  await expect(page.getByTestId('enrich-drawer').getByText('1 column', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')

  // A slow run: the menu offers View Run and Stop instead of new runs.
  // One batch of 5 rows, each answer 5 s away: time to edit and stop it.
  await mockTreg.set({ delayMs: 5000 })
  before = runIdsOf(sheetId).length
  dialog = await menuRun(page, /Run All Rows Again/, 'Run all rows again', 'all 5 rows again')
  await dialog.getByRole('button', { name: 'Run', exact: true }).click()
  await expect.poll(() => runIdsOf(sheetId).length, { timeout: 15_000 }).toBe(before + 1)
  const slow = runIdsOf(sheetId)[before]
  // Edit while it runs: Set up waits for it instead of offering a run the server refuses.
  await openMenu(page)
  await page.getByRole('menuitem', { name: /Edit Enrichment/ }).click()
  await expect(page.getByTestId('enrich-run-reason'))
    .toContainText('A run is still filling this column', { timeout: 15_000 })
  await page.keyboard.press('Escape')
  await openMenu(page)
  await expect(page.getByRole('menu')).toContainText('Stop Enrichment Run')
  await expect(page.getByRole('menu')).not.toContainText('Retry Failed Rows')
  await page.getByRole('menuitem', { name: /Stop Enrichment Run/ }).click()
  expect((await waitRun(api, slow, ['cancelled'])).status).toBe('cancelled')
  // Stopping clears what it hadn't reached: no ⏳ left, in its outputs either.
  const waiting = async () => (await rowsOf(api, sheetId)).filter(r => Object.values(r).some(v => v.includes('⏳')))
  await expect.poll(async () => (await waiting()).length, { timeout: 15_000 }).toBe(0)
  // Its calls in flight still finish and reach the ledger (before the next spec).
  await expectSettledBilledOnce(runIdsOf(sheetId))
  await api.dispose()
})

test("a rerun's estimate is a pure read; the spend card adds up the ledger", async ({ page, context }) => {
  test.setTimeout(60_000)
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId } = await seedLeadRows(api, LEADS)
  const first = await startRun(api, sheetId, findRun())
  await waitRun(api, first, ['completed'])
  const runs = runIdsOf(sheetId).length
  const cols = (await (await api.get(`/api/sheets/${sheetId}?limit=1&offset=0`)).json()).data.columns
  const res = await api.post(`/api/enrich/sheets/${sheetId}/reruns`,
    { data: { column: COL, mode: 'all', status: 'any', estimateOnly: true } })
  expect(res.ok()).toBeTruthy()
  const { estimate } = await res.json()
  expect(estimate.rows).toBe(5)
  expect(estimate.highUsd).toBeGreaterThan(0)
  expect(runIdsOf(sheetId)).toHaveLength(runs)
  expect((await (await api.get(`/api/sheets/${sheetId}?limit=1&offset=0`)).json()).data.columns).toEqual(cols)
  // A plain HTTP rerun still refuses an enrichment column.
  const plain = await api.post('/api/http/rerun', { data: { sheetId, masterColumnName: COL } })
  expect(plain.status()).toBe(400)
  // A start with no rows to take is refused, not started.
  const none = await api.post(`/api/enrich/sheets/${sheetId}/runs`,
    { data: findRun({ continueColumn: true, rows: { mode: 'all', status: 'failed', test: false } }) })
  expect(none.status()).toBe(400)
  expect((await none.json()).error).toBe('No rows here failed.')
  expect(runIdsOf(sheetId)).toHaveLength(runs)
  // Counts by status for the drawer.
  const counts = await (await api.post(`/api/enrich/sheets/${sheetId}/row-counts`,
    { data: { column: COL, mode: 'all' } })).json()
  expect(counts).toEqual({ total: 5, notEnriched: 0, noResult: 0, failed: 0 })

  const spent = (await runStatus(api, first)).spentUsd as number
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/settings/http-enrichment`)
  const card = page.getByTestId('enrich-spend-card')
  await expect(card.getByTestId('enrich-spend-total'))
    .toContainText(/Total \$[\d.]+ · [\d,]+ calls? to treg/, { timeout: 15_000 })
  await expect(card).toContainText(`› Sheet1 · ${COL}`)
  const spend = await (await api.get('/api/enrich/spend?days=30')).json()
  expect(spend.totalUsd).toBeGreaterThanOrEqual(spent - 1e-9)
  await api.dispose()
})
