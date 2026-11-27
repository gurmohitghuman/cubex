import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { authedApi, BASE, makeAccessToken } from './helpers'
import { freshTreg, readDb, rowsOf, seedCsv, waitRun } from './helpers-enrich'
import { companiesCsv, waitAdded } from './helpers-list'
import { mockTreg } from './helpers-treg'
import { call, callError, mcpClient } from './helpers-mcp'
import { openColumnType } from './helpers-ui'

// Open roles at the companies on a sheet (services/open-roles.ts) against the mock's job index
// (tests/mock-treg/jobs.mjs, whose "SDR" roles fall two at each of Northwind, Bluefin and Copperleaf): from the
// enrichment drawer, the website column picked for the person, the cost first (a free count, no paid call), then the
// run: each role into an Open roles sheet beside the sheet, its Domain the company's own website cell, and a column
// counting each company's roles once the run is done. Opened again, the dialog has what it was run with, and a run adds
// only the new role. Agents: hiring_signals open_roles and POST /api/v1/sheets/:id/open-roles, the estimate by default,
// a run held to its most (409 with the estimate now), the run scope needed.

const drawer = (page: Page) => page.getByTestId('enrich-drawer')
const dialog = (page: Page) => page.getByTestId('open-roles-dialog')
const COMPANIES: Array<[string, string]> = [
  ['Northwind', 'https://www.northwind-labs.io/'], ['Nobody', ''], ['Bluefin', 'bluefin-data.io'],
  ['Copperleaf', 'copperleaf-systems.io/careers'],
]
const paidCalls = async () => (await mockTreg.requests()).map(r => r.path)
  .filter(p => p.startsWith('/call/') && !p.endsWith('.count'))

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await read()
    if (ok(v)) return v
    if (Date.now() > end) throw new Error(`${what}: ${JSON.stringify(v).slice(0, 400)}`)
    await new Promise(r => setTimeout(r, 300))
  }
}
const newestRun = (sheetId: string): string => readDb(db => db.prepare(`SELECT id FROM http_runs WHERE sheet_id = ?
  AND master_column_name = 'Open roles found' AND setup_only = 0 ORDER BY created_at DESC, rowid DESC LIMIT 1`)
  .pluck().get(sheetId) as string)
const rolesSheetOf = (tableId: string): string => readDb(db => db.prepare(`SELECT id FROM sheets WHERE table_id = ?
  AND name = 'Open roles' AND trash_id IS NULL`).pluck().get(tableId) as string)
// A run followed to its end: its rows added to Open roles.
async function finished(api: APIRequestContext, sheetId: string, runId: string) {
  await waitRun(api, runId, ['completed'])
  await waitAdded(sheetId)
}
// Each company's count as the sheet has it, once every website row has one.
const counts = async (api: APIRequestContext, sheetId: string, want: Record<string, string>) =>
  until(async () => Object.fromEntries((await rowsOf(api, sheetId)).map(r => [r.Company, r['Open roles'] ?? ''])),
    c => Object.entries(want).every(([k, v]) => c[k] === v), 'the Open roles counts')

test('the drawer: the cost first, then each role into Open roles, counted per company; again, only the new role',
  async ({ page, context }) => {
  test.setTimeout(150_000)
  const api = await authedApi()
  await freshTreg(api)
  const { tableId, sheetId } = await seedCsv(api, companiesCsv(COMPANIES))
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })

  await openColumnType(page, 'Enrichment')
  await drawer(page).getByTestId('open-roles-popular').click()
  await expect(dialog(page).getByLabel('Website column')).toHaveValue('Website')
  await dialog(page).getByLabel('Role titles').fill('SDR')
  await dialog(page).getByTestId('open-roles-cost-step').click()
  await expect(page.getByTestId('open-roles-matches')).toContainText('open roles match at the first 3 companies')
  await expect(page.getByTestId('open-roles-cost')).toContainText('never more')
  expect(await paidCalls(), 'the cost is free to see').toEqual([])
  await dialog(page).getByTestId('open-roles-go').click()
  await expect(dialog(page)).toBeHidden({ timeout: 15_000 })

  await finished(api, sheetId, newestRun(sheetId))
  const roles = await rowsOf(api, rolesSheetOf(tableId))
  expect(roles.map(r => r.Domain).sort()).toEqual(['bluefin-data.io', 'bluefin-data.io',
    'copperleaf-systems.io/careers', 'copperleaf-systems.io/careers', 'https://www.northwind-labs.io/',
    'https://www.northwind-labs.io/'])
  expect(roles.every(r => r.Title.includes('SDR') && r.Link.startsWith('https://jobs.') && r['First seen'])).toBe(true)
  await counts(api, sheetId, { Northwind: '2', Bluefin: '2', Copperleaf: '2' })
  // The sheet shows the new column (its header cut short to fit) and the Open roles tab.
  await expect(page.locator('.ag-header-cell-text', { hasText: /^Open roles$/ })).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('[aria-label="Sheet options for Open roles"]')).toBeVisible()

  // Again: the dialog has what it was run with; one new role at Northwind (and two at companies not on the sheet).
  await mockTreg.set({ jobsNew: { SDR: 3 } })
  await openColumnType(page, 'Enrichment')
  await drawer(page).getByTestId('open-roles-popular').click()
  await expect(dialog(page).getByLabel('Role titles')).toHaveValue('SDR')
  await expect(dialog(page)).toContainText('Searched before')
  await dialog(page).getByTestId('open-roles-cost-step').click()
  await dialog(page).getByTestId('open-roles-go').click()
  await expect(dialog(page)).toBeHidden({ timeout: 15_000 })
  await finished(api, sheetId, newestRun(sheetId))
  const again = await rowsOf(api, rolesSheetOf(tableId))
  expect(again).toHaveLength(7)
  expect(again.filter(r => r.Link.includes('/sdr-new-')).map(r => r.Domain)).toEqual(['https://www.northwind-labs.io/'])
  await counts(api, sheetId, { Northwind: '3', Bluefin: '2', Copperleaf: '2' })
})

test('agents: the estimate by default, the run held to its most, the run scope needed', async () => {
  test.setTimeout(120_000)
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId } = await seedCsv(api, companiesCsv(COMPANIES))
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e open roles'))
  const ask = { action: 'open_roles', sheet_id: sheetId, website_column: 'Website', roles: ['SDR'] }
  const est = await call(client, 'hiring_signals', ask)
  expect(est).toMatchObject({ estimate_only: true, companies: 4, roles_up_to: 40, price_known: true,
    matches: { companies_counted: 3, at_least: false } })
  expect(await paidCalls()).toEqual([])
  const low = await callError(client, 'hiring_signals', { ...ask, estimate_only: false, max_cost_usd: 0.0001 })
  expect(low).toContain('more than the')
  const started = await call(client, 'hiring_signals', { ...ask, estimate_only: false, max_cost_usd: est.high_usd })
  expect(started).toMatchObject({ column: 'Open roles found', roles_sheet_name: 'Open roles',
    lookup_columns: ['Open roles'] })
  await finished(api, sheetId, started.run_id)
  await counts(api, sheetId, { Northwind: '2', Bluefin: '2', Copperleaf: '2' })

  const runner = { Authorization: `Bearer ${await makeAccessToken(api, ['run'], 'e2e open roles runner')}` }
  const body = { website_column: 'Website', roles: ['SDR'] }
  const rest = await (await api.post(`/api/v1/sheets/${sheetId}/open-roles`, { headers: runner, data: body })).json()
  expect(rest).toMatchObject({ estimate_only: true, companies: 4 })
  const over = await api.post(`/api/v1/sheets/${sheetId}/open-roles`,
    { headers: runner, data: { ...body, estimate_only: false, max_cost_usd: 0.0001 } })
  expect(over.status()).toBe(409)
  expect(await over.json()).toMatchObject({ over_ceiling: true, estimate: { companies: 4 } })
  const writer = { Authorization: `Bearer ${await makeAccessToken(api, ['read', 'write'], 'e2e open roles writer')}` }
  expect((await api.post(`/api/v1/sheets/${sheetId}/open-roles`, { headers: writer, data: body })).status())
    .toBe(403)
  const bad = await api.post(`/api/v1/sheets/${sheetId}/open-roles`,
    { headers: runner, data: { website_column: 'Site', roles: ['SDR'] } })
  expect(bad.status()).toBe(400)
  expect((await bad.json()).error).toContain('"Site"')
})
