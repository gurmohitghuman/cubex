import { test, expect } from '@playwright/test'
import { authedApi, makeAccessToken, BASE } from './helpers'
import { freshTreg, rowsOf, waitRun } from './helpers-enrich'
import { mockTreg } from './helpers-treg'
import { call, mcpClient } from './helpers-mcp'

// A hiring table for agents and in the app (services/hiring-*.ts, mcp/tools-hiring.ts, routes/api-v1-hiring.ts):
// the MCP tool asks for the estimate unless told otherwise, checks by the Companies sheet's id too, and read_rows
// filters the companies with new roles; /api/v1 needs write to make one and run to check it. In the app, the
// dashboard's dialog makes the table, which opens on its first check's estimate, and the banner follows the check.

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

test('MCP and /api/v1: create free, the estimate by default, check, the companies with new roles', async () => {
  test.setTimeout(120_000)
  const api = await authedApi()
  await freshTreg(api)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e hiring'))
  const made = await call(client, 'hiring_signals', { action: 'create', roles: ['SDR'], country: 'US' })
  expect(made).toMatchObject({ searches: 1, per_search: 25, roles: ['SDR'], checks: [] })
  expect(made.table_name).toMatch(/^Hiring: SDR( \d+)?$/)
  const est = await call(client, 'hiring_signals', { action: 'check', id: made.companies_sheet_id })
  expect(est).toMatchObject({ estimate_only: true, searches: 1, roles_up_to: 25, new_since: null,
    matches: { about: 120, searches_counted: 1, at_least: false } })
  expect(await paidCalls()).toEqual([])

  const checkOnce = async () => {
    const c = await call(client, 'hiring_signals', { action: 'check', id: made.id, estimate_only: false })
    expect(c.stage).toBe('searching')
    await waitRun(api, c.run_id, ['completed'])
    return until(() => call(client, 'hiring_signals', { action: 'get', id: made.id }),
      v => v.checks[0].stage === 'done', 'check')
  }
  const newOnes = async () => (await call(client, 'read_rows', { sheet_id: made.companies_sheet_id,
    where: [{ column: 'New roles', operator: 'gt', value: '0' }], columns: ['Domain', 'New roles'] })).rows
  expect((await checkOnce()).checks[0]).toMatchObject({ roles_added: 10, companies_new: 5 })
  expect(await newOnes()).toEqual([])
  await mockTreg.set({ jobsNew: { SDR: 1 } })
  const again = await checkOnce()
  expect(again.checks[0]).toMatchObject({ roles_added: 1, companies_hiring_more: 1, new_since: again.checks[1].day })
  const domains = (await newOnes()).map((r: { data: Record<string, string> }) => r.data.Domain)
  expect(domains).toEqual(['harborview-health.io'])

  // /api/v1: a write-only token makes and reads one, and can't check it.
  const writer = { Authorization: `Bearer ${await makeAccessToken(api, ['read', 'write'], 'e2e hiring writer')}` }
  const rest = await api.post('/api/v1/hiring', { headers: writer, data: { roles: ['RevOps Manager'] } })
  expect(rest.status()).toBe(201)
  const id = (await rest.json()).id
  expect((await (await api.get(`/api/v1/hiring/${id}`, { headers: writer })).json()).roles).toEqual(['RevOps Manager'])
  expect((await api.post(`/api/v1/hiring/${id}/check`, { headers: writer, data: {} })).status()).toBe(403)
  const runner = { Authorization: `Bearer ${await makeAccessToken(api, ['run'], 'e2e hiring runner')}` }
  const restEst = await (await api.post(`/api/v1/hiring/${id}/check`, { headers: runner, data: {} })).json()
  expect(restEst).toMatchObject({ estimate_only: true, searches: 1 })
  const bad = await api.post('/api/v1/hiring', { headers: writer, data: { roles: [], country: 'USA' } })
  expect(bad.status()).toBe(400)
  await api.dispose()
})

test('the app: make the table from the dashboard, check it from the estimate it opens on', async ({
  page, context,
}) => {
  test.setTimeout(120_000)
  const api = await authedApi()
  await freshTreg(api)
  for (const t of await (await api.get('/api/tables')).json()) await api.delete(`/api/tables/${t.id}`)
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/`)
  await page.getByTestId('hiring-open').click()
  const dialog = page.getByTestId('hiring-dialog')
  await dialog.getByLabel('Role titles').fill('SDR\nBDR\nsdr')
  await dialog.getByLabel('City or region').fill('Texas')
  await expect(dialog).toContainText('2 searches, up to 25 roles each')
  await dialog.getByTestId('hiring-create').click()

  const confirm = page.getByTestId('hiring-check-confirm')
  await expect(confirm).toContainText(
    'Searches 2 role titles for roles in Texas, US, posted in the last 30 days, adding up to 50', { timeout: 30_000 })
  await expect(confirm.getByTestId('hiring-check-matches')).toContainText('About 240 open roles match')
  await expect(confirm.getByTestId('hiring-check-cost')).toContainText('never more')
  expect(await paidCalls()).toEqual([])
  await page.screenshot({ path: process.env.HIRING_SHOTS ? `${process.env.HIRING_SHOTS}/confirm.png` : undefined })
  await confirm.getByTestId('hiring-check-go').click()
  await expect(confirm).toBeHidden()

  const banner = page.getByTestId('hiring-banner')
  await expect(banner).toContainText('Companies hiring: SDR, BDR')
  await expect(banner.getByTestId('hiring-last-check'))
    .toContainText(/Last check, \w{3} \d+: 20 new roles, 5 new companies/, { timeout: 30_000 })
  const sheetId = new URL(page.url()).pathname.split('/').pop()!
  await until(() => rowsOf(api, sheetId), r => r.length === 5, 'companies')
  await expect(page.locator('.ag-cell').filter({ hasText: 'northwind-labs.io' }).first())
    .toBeVisible({ timeout: 15_000 })
  await page.screenshot({ path: process.env.HIRING_SHOTS ? `${process.env.HIRING_SHOTS}/companies.png` : undefined })
  // The banner on Roles too, and Check again opens the estimate again.
  await banner.getByRole('button', { name: 'Roles' }).click()
  await expect(page.locator('.ag-cell').filter({ hasText: 'SDR' }).first()).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('hiring-check').click()
  await expect(page.getByTestId('hiring-check-confirm')).toContainText('Check again')
  await api.dispose()
})
