import { test, expect, APIRequestContext } from '@playwright/test'
import { authedApi, makeAccessToken, BASE } from './helpers'
import { freshTreg, mockBilling, rowsOf, waitRun } from './helpers-enrich'
import { waitAdded } from './helpers-list'
import { mockTreg } from './helpers-treg'
import { call, callError, mcpClient } from './helpers-mcp'
import { waitSetup } from './helpers-setups'
import { clickToVisible, median } from './helpers-speed'

// Find buyers on a hiring table (services/hiring-buyer.ts, hiring-buyer-agent.ts, mcp/tools-hiring.ts,
// components/hiring/HiringBuyersDialog.tsx), against the mock treg: the first estimate adds the buyer columns to
// Companies (free, the write scope; a run-only token is told so), the run needs the estimate's most and then fills,
// for each company, a person holding the titles with a verified email; a company with no one costs nothing and gets
// no email search. /api/v1 answers the same. In the app, Find buyers… on the banner opens at once on the titles the
// table's roles start with, shows the cost (adding the columns) and runs.

const SDR_TITLES = ['Head of Sales Development', 'VP Sales', 'Head of Sales']
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

// A hiring table checked once: Companies has the mock's five companies.
async function checkedTable(api: APIRequestContext, roles: string[]) {
  const made = await api.post('/api/hiring', { data: { roles, country: 'US' } })
  expect(made.ok(), await made.text()).toBeTruthy()
  const h = (await made.json()).hiring
  const est = (await (await api.post(`/api/hiring/${h.id}/check`, { data: { estimateOnly: true } })).json()).estimate
  const res = await api.post(`/api/hiring/${h.id}/check`, { data: { timeZone: 'UTC', maxCostUsd: est.highUsd } })
  const started = await res.json()
  expect(res.ok(), JSON.stringify(started)).toBeTruthy()
  await waitRun(api, started.check.runId, ['completed'])
  await waitAdded(h.searchesSheetId)
  await until(async () => (await (await api.get(`/api/hiring/${h.id}`)).json()).hiring.checks[0].stage,
    s => s === 'done', 'check')
  return h as { id: string; tableId: string; companiesSheetId: string }
}

test('MCP and /api/v1: the estimate adds the columns, the run finds a buyer and an email per company', async () => {
  test.setTimeout(150_000)
  const api = await authedApi()
  await freshTreg(api)
  const h = await checkedTable(api, ['SDR'])
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e buyers'))
  await call(client, 'append_rows', { sheet_id: h.companiesSheetId,
    rows: [{ Company: 'Nobody Inc', Domain: 'nobody.example' }] })
  const runOnly = await mcpClient(await makeAccessToken(api, ['read', 'run'], 'e2e buyers run only'))
  expect(await callError(runOnly, 'hiring_signals', { action: 'find_buyers', id: h.id }))
    .toMatch(/^Saving the buyer columns needs the write scope/)

  const before = await call(client, 'hiring_signals', { action: 'get', id: h.id })
  expect(before.buyer).toMatchObject({ added: false, titles: [], starting_titles: SDR_TITLES })
  await mockTreg.reset()
  const est = await call(client, 'hiring_signals', { action: 'find_buyers', id: h.id })
  expect(est).toMatchObject({ estimate_only: true, buyer_titles: SDR_TITLES,
    saved_columns: ['Buyer search', 'Buyer email search'] })
  expect(est.estimate.rows_in_scope).toBe(6)
  expect(est.estimate.columns.map((c: { column: string }) => c.column)).toEqual(['Buyer search', 'Buyer email search'])
  expect(est.changed[0].columns).toEqual(expect.arrayContaining(['Buyer', 'Buyer title', 'Buyer LinkedIn',
    'Buyer email', 'Buyer email status']))
  expect(await paidCalls()).toEqual([])
  expect(await callError(client, 'hiring_signals', { action: 'find_buyers', id: h.id, estimate_only: false }))
    .toMatch(/^Finding buyers needs max_cost_usd/)

  const run = await call(client, 'hiring_signals', { action: 'find_buyers', id: h.id, estimate_only: false,
    max_cost_usd: est.estimate.high_usd })
  expect(run.estimate_only).toBe(false)
  expect((await waitSetup(client, run.setup_run.id)).status).toBe('done')
  const rows = await rowsOf(api, h.companiesSheetId)
  const nobody = rows.find(r => r.Domain === 'nobody.example')!
  expect([nobody.Buyer ?? '', nobody['Buyer email'] ?? '']).toEqual(['', ''])
  const found = rows.filter(r => r.Domain && r.Domain !== 'nobody.example')
  expect(found).toHaveLength(5)
  for (const r of found) {
    expect(r.Buyer).toMatch(/^Dana /)
    expect(r['Buyer title']).toBe(SDR_TITLES[0])
    expect(r['Buyer LinkedIn']).toMatch(/^https:\/\/www\.linkedin\.com\/in\/dana-/)
    expect(r['Buyer email']).toMatch(new RegExp(`@${r.Domain.replace(/\./g, '\\.')}$`))
  }
  // One person billed per company that had one; the company with no one cost nothing.
  const searches = (await mockBilling()).filter(b => b.toolId === 'findymail.search.employees')
  expect(searches.filter(b => b.costMicro > 0)).toHaveLength(5)

  // /api/v1 with a run-only token: the columns are there and the titles the same, so nothing to save.
  const token = await makeAccessToken(api, ['read', 'run'], 'e2e buyers rest')
  const auth = { Authorization: `Bearer ${token}` }
  const rest = await api.post(`/api/v1/hiring/${h.id}/buyers`, { headers: auth, data: { rows: 'all' } })
  const body = await rest.json()
  expect(rest.status(), JSON.stringify(body)).toBe(200)
  expect(body).toMatchObject({ estimate_only: true, saved_columns: [], buyer_titles: SDR_TITLES })
  const renamed = await api.post(`/api/v1/hiring/${h.id}/buyers`, { headers: auth, data: { buyer_titles: ['CRO'] } })
  expect(renamed.status()).toBe(403)
  const got = await (await api.get(`/api/v1/hiring/${h.id}`, { headers: auth })).json()
  expect(got.buyer).toMatchObject({ added: true, titles: SDR_TITLES })
  await api.dispose()
})

test('the app: Find buyers… opens at once on the roles\' titles, shows the cost, then finds them', async ({
  page, context,
}) => {
  test.setTimeout(150_000)
  const api = await authedApi()
  await freshTreg(api)
  const h = await checkedTable(api, ['Account Executive'])
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${h.tableId}/${h.companiesSheetId}`)
  const banner = page.getByTestId('hiring-banner')
  const open = banner.getByTestId('hiring-find-buyers')
  await expect(open).toBeEnabled()
  const ms: number[] = []
  for (let i = 0; i < 3; i++) {
    ms.push((await clickToVisible(page, open, '[data-testid=hiring-buyers]')).ms)
    await page.getByTestId('hiring-buyers').getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByTestId('hiring-buyers')).toHaveCount(0)
  }
  console.log(`Find buyers… click to visible: ${ms.join(', ')} ms`)
  expect(median(ms), 'median click to visible').toBeLessThan(150)

  await open.click()
  const dialog = page.getByTestId('hiring-buyers')
  await expect(dialog.getByTestId('hiring-buyers-titles')).toHaveValue('VP Sales, Head of Sales, Chief Revenue Officer')
  await dialog.getByTestId('hiring-buyers-titles').fill('VP Sales, Head of Sales')
  await dialog.getByTestId('hiring-buyers-price').click()
  await expect(dialog.getByTestId('column-run-estimate')).toContainText('Buyer search')
  await expect(dialog.getByTestId('hiring-buyers-cost')).toContainText('never more')
  // The new columns are in the sheet at once (past the right edge: the grid draws only the headers in view).
  await expect(page.getByText(/16 columns/i).first()).toBeVisible()
  // One person a company: its most is Findymail's price for one, $0.0198.
  await expect(dialog.getByTestId('column-run-estimate-row').first()).toContainText('$0.10')
  await dialog.getByTestId('hiring-buyers-go').click()
  await expect(dialog).toHaveCount(0)
  await until(async () => (await rowsOf(api, h.companiesSheetId)).filter(r => r['Buyer email']).length,
    n => n === 5, 'buyer emails')
  const rows = await rowsOf(api, h.companiesSheetId)
  expect(new Set(rows.map(r => r['Buyer title']))).toEqual(new Set(['VP Sales']))
  await api.dispose()
})
