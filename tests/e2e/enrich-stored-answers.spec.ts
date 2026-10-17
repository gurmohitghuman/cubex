import { test, expect, Page } from '@playwright/test'
import { authedApi, BASE } from './helpers'
import { freshTreg, readDb, resultsOf, seedLeadRows, startRun, waitRun } from './helpers-enrich'
import { bearer, makeToken } from './api-v1-run-helpers'
import { setAutorun } from './helpers-autorun'

// M9: stored answers and what a run sets off. A row enriched again prunes the
// raw part of its older answer in the background (output and _treg stay, the
// newest answer keeps raw); /api/health reports treg from the last call;
// Settings shows the stored answers' size and prunes old answers' details; the
// drawer's Run confirm and an agent's run start name the auto-runs it sets off.

const COL = 'Find email'
const LEADS = [
  { Name: 'Ada One', Website: 'good1.example' }, { Name: 'Bo Two', Website: 'good2.example' },
  { Name: 'Cy Three', Website: 'good3.example' },
]
const findRun = (over: Record<string, unknown> = {}) => ({
  toolId: 'treg.people.email.find', preset: null, columnName: COL, continueColumn: false,
  inputs: { full_name: { column: 'Name' }, domain: { column: 'Website' } }, cleanDomains: true,
  providerOrder: [], skipProviders: [], stopAtFirst: false, email: null,
  outputs: [{ key: 'email', path: '$.output.email', columnName: 'Email' }],
  rows: { mode: 'all', test: false }, conditions: [], maxCostPerRowUsd: null, spendLimitUsd: null, fresh: false,
  ...over,
})
const generationOf = (sheetId: string): number =>
  readDb(db => db.prepare('SELECT row_generation FROM sheets WHERE id = ?').pluck().get(sheetId))
const selected = (sheetId: string, rowIndexes: number[]) => ({
  continueColumn: true, rows: { mode: 'selected', status: 'any', test: false, rowIndexes },
  rowGeneration: generationOf(sheetId),
})

test('a row enriched again prunes its older answer; health reports treg', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId } = await seedLeadRows(api, LEADS)
  const first = await startRun(api, sheetId, findRun())
  await waitRun(api, first, ['completed'])
  expect(resultsOf(first).every(r => r.response && 'raw' in r.response)).toBe(true)

  const again = await startRun(api, sheetId, findRun(selected(sheetId, [1])))
  await waitRun(api, again, ['completed'])
  await expect.poll(() => resultsOf(first)[1].response.$prunedAt ?? null, { timeout: 15_000 }).not.toBeNull()
  const old = resultsOf(first)
  expect('raw' in old[1].response).toBe(false)
  expect(old[1].response.output.email).toBeTruthy()
  expect(old[1].response._treg).toBeTruthy()
  expect('raw' in old[0].response && 'raw' in old[2].response).toBe(true)
  expect('raw' in resultsOf(again)[0].response).toBe(true)
  // Both runs' passes are done.
  expect(readDb(db => db.prepare('SELECT COUNT(*) FROM http_runs WHERE sheet_id = ? AND answers_pruned = 0')
    .pluck().get(sheetId))).toBe(0)

  // The answer panel reads the newest answer, which kept its raw part.
  const q = `column=${encodeURIComponent(COL)}&row=1`
  const panel = await (await api.get(`/api/enrich/sheets/${sheetId}/answer?${q}`)).json()
  expect(panel.answer?.prunedAt ?? panel.prunedAt ?? null).toBeNull()

  const health = await (await api.get('/api/health')).json()
  expect(health.treg).toBe('ok')
  expect(typeof health.tregSince).toBe('string')
  await api.dispose()
})

test('Settings: the stored answers size, and pruning old details', async ({ page, context }) => {
  test.setTimeout(60_000)
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId } = await seedLeadRows(api, LEADS)
  await waitRun(api, await startRun(api, sheetId, findRun()), ['completed'])
  const expected = readDb(db => db.prepare(`SELECT COUNT(*) AS n, SUM(octet_length(response_data)) AS b
    FROM http_results r JOIN http_runs h ON h.id = r.run_id
    WHERE json_type(h.config, '$.enrichment') IS NOT NULL AND r.response_data IS NOT NULL`).get()) as
    { n: number; b: number }

  // A count older than an hour (or none) is redone in the background.
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/settings/http-enrichment`)
  const line = page.getByTestId('stored-answers-size')
  // A count an earlier spec made minutes ago stays (it's redone after an hour).
  await expect(line).toContainText(/in [\d,]+ answers?, counted (just now|\d+ minutes? ago)/, { timeout: 20_000 })
  // The count reads every enrichment answer's size (a recent count from an earlier spec stays as it was).
  const counted = await (await api.get('/api/enrich/stored-answers')).json()
  expect(counted.answers).toBeGreaterThan(0)
  if (counted.answers === expected.n) expect(counted.bytes).toBe(expected.b)

  await page.getByTestId('stored-answers-prune').click()
  const dialog = page.getByRole('dialog').filter({ hasText: 'Prune details older than 90 days?' })
  await expect(dialog).toContainText("Their result fields stay")
  await dialog.getByRole('button', { name: 'Prune' }).click()
  await expect(page.getByTestId('stored-answers-prune-status'))
    .toContainText(/Last prune on .+: nothing older than 90 days had details left\./, { timeout: 20_000 })
  const view = await (await api.get('/api/enrich/stored-answers')).json()
  expect(view.prune.status).toBe('done')
  expect(view.prune.pruned).toBe(0)
  // One prune at a time: a second start while one runs is refused (here it already ended, so it starts).
  expect([202, 409]).toContain((await api.post('/api/enrich/stored-answers/prune')).status())
  await api.dispose()
})

async function openEdit(page: Page) {
  await page.locator('.ag-header-cell').filter({ hasText: COL }).first().locator('.ag-header-cell-text').first()
    .click()
  await page.getByRole('menuitem', { name: /Edit Enrichment/ }).click()
  await expect(page.getByText('Edit enrichment', { exact: true })).toBeVisible({ timeout: 15_000 })
}

test('the Run confirm and an agent start name the auto-runs a run sets off', async ({ page, context }) => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await freshTreg(api)
  const { tableId, sheetId } = await seedLeadRows(api, LEADS)
  // Find email on the first row only, Verify on its Email, then auto-run on Verify.
  await waitRun(api, await startRun(api, sheetId, findRun({ ...selected(sheetId, [0]), continueColumn: false })),
    ['completed'])
  await waitRun(api, await startRun(api, sheetId, {
    ...findRun(), toolId: 'treg.people.email.verify', columnName: 'Verify', cleanDomains: false,
    inputs: { email: { column: 'Email' } },
    outputs: [{ key: 'status', path: '$.output.status', columnName: 'Email status' }],
    rows: { mode: 'selected', status: 'any', test: false, rowIndexes: [0] }, rowGeneration: generationOf(sheetId),
  }), ['completed'])
  await setAutorun(api, sheetId, { column: 'Verify', enabled: true, dailyCapUsd: 1 })

  const est = await (await api.post(`/api/autorun/sheets/${sheetId}/estimate`,
    { data: { rows: 2, after: [COL, 'Email'] } })).json()
  expect(est.autoRuns.map((a: { column: string }) => a.column)).toEqual(['Verify'])
  const none = await (await api.post(`/api/autorun/sheets/${sheetId}/estimate`,
    { data: { rows: 2, after: ['Website'] } })).json()
  expect(none.autoRuns).toEqual([])

  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  await openEdit(page)
  await expect(page.getByTestId('enrich-run-all')).toHaveText('Run on 2 rows', { timeout: 15_000 })
  await page.getByTestId('enrich-run-all').click()
  const dialog = page.getByRole('dialog').filter({ hasText: 'Run the enrichment' })
  await expect(dialog).toContainText(/Also runs: Verify \(about \$[\d.]+ to \$[\d.]+\)\./, { timeout: 15_000 })
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  // An agent's start answers with the same list.
  const v1 = await bearer(await makeToken(api, ['read', 'write', 'run'], `e2e chained ${Date.now()}`))
  const started = await v1.post(`/api/v1/sheets/${sheetId}/enrichment-runs`, {
    data: {
      tool_id: 'treg.people.email.find', column_name: COL, add_to_column: true,
      inputs: { full_name: 'Name', domain: 'Website' }, outputs: [{ field: 'email', column_name: 'Email' }],
    },
  })
  const body = await started.json()
  expect(started.status(), JSON.stringify(body)).toBe(202)
  expect(body.chained_auto_run.map((a: { column: string }) => a.column)).toEqual(['Verify'])
  await waitRun(api, body.run_id, ['completed'])
  await api.dispose()
})
