import { test, expect, APIRequestContext } from '@playwright/test'
import { authedApi, makeAccessToken, BASE } from './helpers'
import { freshTreg, mockBilling, rowsOf, waitRun } from './helpers-enrich'
import { waitAdded } from './helpers-list'
import { mockTreg } from './helpers-treg'
import { call, callError, mcpClient } from './helpers-mcp'

// A hiring table's filters on Companies (lib/hiring/company-filters.ts, services/hiring-summarize-write.ts) against
// the mock's job search (tests/mock-treg/jobs.mjs: an SDR search finds 10 roles, 2 at each of 5 companies): with
// "at least 3", the first check gives no company a row and keeps all 5 off, while Roles gets every role and the
// search costs what a table's without the filter costs; the next check adds the company that reached 3. In the
// app, More options make a table with "at least 2" and one company left out: the check's estimate says their
// roles are still searched and paid for, Companies gets the 4 others, the banner says 1 was kept off. /api/v1 and
// MCP take min_roles and leave_out_companies, answer them back and refuse them word for word.

const jobSpend = async () => (await mockBilling()).filter(b => b.toolId.includes('jobs.search')
  && !b.toolId.endsWith('.count')).reduce((n, b) => n + b.costMicro, 0)
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await read()
    if (ok(v)) return v
    if (Date.now() > end) throw new Error(`${what}: ${JSON.stringify(v).slice(0, 400)}`)
    await new Promise(r => setTimeout(r, 300))
  }
}
async function make(api: APIRequestContext, input: Record<string, unknown>) {
  const res = await api.post('/api/hiring', { data: input })
  expect(res.ok(), await res.text()).toBeTruthy()
  return (await res.json()).hiring
}
const hiring = async (api: APIRequestContext, id: string) => (await (await api.get(`/api/hiring/${id}`)).json()).hiring
const estimate = async (api: APIRequestContext, id: string) =>
  (await (await api.post(`/api/hiring/${id}/check`, { data: { estimateOnly: true } })).json()).estimate
async function check(api: APIRequestContext, h: { id: string; searchesSheetId: string }) {
  const res = await api.post(`/api/hiring/${h.id}/check`,
    { data: { timeZone: 'UTC', maxCostUsd: (await estimate(api, h.id)).highUsd } })
  const started = await res.json()
  expect(res.ok(), JSON.stringify(started)).toBeTruthy()
  await waitRun(api, started.check.runId, ['completed'])
  await waitAdded(h.searchesSheetId)
  return (await until(() => hiring(api, h.id), v => v.checks[0].stage === 'done', 'check')).checks[0]
}

test('at least 3: no row until a company reaches it; every role still searched, paid for and kept', async () => {
  test.setTimeout(150_000)
  const api = await authedApi()
  await freshTreg(api)
  const h = await make(api, { roles: ['SDR'], country: 'US', minRoles: 3 })
  expect(h).toMatchObject({ minRoles: 3, leaveOutCompanies: [] })
  const plain = await make(api, { roles: ['SDR'], country: 'US' })
  // The same search: the same estimate and free count.
  expect(await estimate(api, h.id)).toEqual(await estimate(api, plain.id))

  const first = await check(api, h)
  expect(first).toMatchObject({ rolesAdded: 10, companiesNew: 0, companiesKeptOff: 5 })
  expect(await rowsOf(api, h.companiesSheetId)).toEqual([])
  expect(await rowsOf(api, h.rolesSheetId)).toHaveLength(10)
  const spent = await jobSpend()
  expect(spent).toBeGreaterThan(0)
  const plainFirst = await check(api, plain)
  expect(plainFirst).toMatchObject({ rolesAdded: 10, companiesNew: 5 })
  expect(await jobSpend() - spent).toBe(spent)

  // One more SDR role at Harborview: it reaches 3.
  await mockTreg.set({ jobsNew: { SDR: 1 } })
  const second = await check(api, h)
  expect(second).toMatchObject({ rolesAdded: 1, companiesNew: 1, companiesKeptOff: 4 })
  expect((await rowsOf(api, h.companiesSheetId)).map(c => [c.Domain, c['Open roles'], c['First seen'],
    c['New roles']])).toEqual([['harborview-health.io', '3', second.label, '1']])
  expect(await rowsOf(api, h.rolesSheetId)).toHaveLength(11)
  await api.dispose()
})

test('the app: at least 2 and one company left out, said before the check, kept off after it', async ({
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
  await dialog.getByLabel('Role titles').fill('SDR')
  await dialog.getByRole('button', { name: 'More options' }).click()
  await dialog.getByLabel('Companies with at least N matching roles').fill('2')
  await dialog.getByLabel('Leave these companies out of Companies').fill('https://www.bluefin-data.io')
  await expect(dialog.getByTestId('hiring-more-options')).toContainText('2 set')
  await expect(dialog).toContainText('Their roles are still searched and paid for, and stay in Roles.')
  await dialog.getByTestId('hiring-create').click()

  const confirm = page.getByTestId('hiring-check-confirm')
  await expect(confirm.getByTestId('hiring-check-kept')).toHaveText('Companies lists only companies with at least '
    + '2 matching roles, and leaves out 1 company. Their roles are still searched and paid for.', { timeout: 30_000 })
  await confirm.getByTestId('hiring-check-go').click()
  const banner = page.getByTestId('hiring-banner')
  await expect(banner).toContainText('at least 2 roles a company, 1 company left out')
  await expect(banner.getByTestId('hiring-last-check')).toContainText(
    '10 new roles, 4 new companies; 1 more company kept off by your filters.', { timeout: 60_000 })
  const v = (await (await api.get(`/api/tables/${(await (await api.get('/api/tables')).json())[0].id}`)).json())
    .sheets as Array<{ id: string; name: string }>
  const companies = await rowsOf(api, v.find(s => s.name === 'Companies')!.id)
  expect(companies.map(c => c.Domain).sort()).toEqual(['copperleaf-systems.io', 'harborview-health.io',
    'northwind-labs.io', 'quillmark.io'])
  expect(await rowsOf(api, v.find(s => s.name === 'Roles')!.id)).toHaveLength(10)
  await api.dispose()
})

test('/api/v1 and MCP: taken, answered back, refused word for word; a table without them as before', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  await freshTreg(api)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e company filters mcp'))
  const made = await call(client, 'hiring_signals', { action: 'create', roles: ['SDR'], min_roles: '2',
    leave_out_companies: ['https://www.Ford.com', 'acme.io'] })
  expect(made).toMatchObject({ min_roles: 2, leave_out_companies: ['ford.com', 'acme.io'] })
  expect(await call(client, 'hiring_signals', { action: 'get', id: made.id }))
    .toMatchObject({ min_roles: 2, leave_out_companies: ['ford.com', 'acme.io'], checks: [] })
  // Refused by the tool's input schema, with the words /api/v1 uses.
  const low = await client.callTool({ name: 'hiring_signals', arguments: { action: 'create', roles: ['SDR'],
    min_roles: 0 } }) as { isError?: boolean; content: Array<{ text: string }> }
  expect(low.isError).toBe(true)
  expect(low.content[0].text).toBe('Input validation error: Invalid arguments for tool hiring_signals: min_roles: '
    + 'min_roles must be a whole number from 1 to 100.')
  expect(await callError(client, 'hiring_signals', { action: 'create', roles: ['SDR'], companies: ['acme.io'],
    leave_out_companies: ['acme.io'] })).toBe('acme.io is in both companies and leave_out_companies: take it out '
    + 'of one.')
  const plain = await call(client, 'hiring_signals', { action: 'create', roles: ['BDR'] })
  expect('min_roles' in plain || 'leave_out_companies' in plain).toBe(false)

  const writer = { Authorization: `Bearer ${await makeAccessToken(api, ['read', 'write'], 'e2e company filters')}` }
  const rest = await api.post('/api/v1/hiring', { headers: writer,
    data: { roles: ['AE'], min_roles: 4, leave_out_companies: ['ramp.com'] } })
  expect(rest.status(), await rest.text()).toBe(201)
  expect(await rest.json()).toMatchObject({ min_roles: 4, leave_out_companies: ['ramp.com'] })
  const bad = await api.post('/api/v1/hiring', { headers: writer, data: { roles: ['AE'], min_roles: 101 } })
  expect(bad.status()).toBe(400)
  expect((await bad.json()).error).toBe('min_roles must be a whole number from 1 to 100.')
  const many = await api.post('/api/v1/hiring', { headers: writer,
    data: { roles: ['AE'], leave_out_companies: Array.from({ length: 201 }, (_, i) => `site${i}.com`) } })
  expect((await many.json()).error).toBe('leave_out_companies takes at most 200 companies.')
  await api.dispose()
})
