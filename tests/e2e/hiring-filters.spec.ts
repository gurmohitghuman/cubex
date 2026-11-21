import { test, expect, APIRequestContext } from '@playwright/test'
import { authedApi, makeAccessToken, BASE } from './helpers'
import { freshTreg, mockBilling, readDb, rowsOf, waitRun } from './helpers-enrich'
import { waitAdded } from './helpers-list'
import { mockTreg } from './helpers-treg'
import { call, callError, mcpClient } from './helpers-mcp'

// A hiring table made with description words, words to leave out, seniority, employment type and chosen companies
// (lib/hiring/filters.ts, search-input.ts, services/hiring-*.ts) against the mock's job index
// (tests/mock-treg/jobs.mjs, which applies them to its roles): made with no paid call, a Searches column per
// filter; the estimate's free count sent the same filters but seniority, and saying so; the check calls the job
// index itself once per search row with a title, each with its own cells (an edited one too), never the row with
// none; only the roles the filters keep go into Roles, each billed once. MCP and /api/v1 take the same lists
// snake_case and answer them back. In the app, the dialog's More options make such a table.

const CHOSEN = ['northwind-labs.io', 'bluefin-data.io', 'harborview-health.io', 'copperleaf-systems.io']
// The bodies the job index (or its count) was sent, by title: a run's rows and a count's searches go at once.
const sentTo = async (path: string) => (await mockTreg.requests()).filter(r => r.path === path)
  .map(r => JSON.parse(r.body)).sort((a, b) => String(a.job_titles[0]).localeCompare(String(b.job_titles[0])))
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
const rowIds = (sheetId: string) => readDb(db => db.prepare('SELECT id FROM rows WHERE sheet_id = ? ORDER BY row_index')
  .pluck().all(sheetId)) as string[]

async function make(api: APIRequestContext, input: Record<string, unknown>) {
  const res = await api.post('/api/hiring', { data: input })
  expect(res.ok(), await res.text()).toBeTruthy()
  return (await res.json()).hiring
}

test('the filters: a column each, the count without seniority, the job index called with each row\'s own',
  async () => {
    test.setTimeout(120_000)
    const api = await authedApi()
    await freshTreg(api)
    const h = await make(api, {
      roles: ['SDR', 'Engineer, Backend'], country: 'US', descriptionWords: 'outbound',
      leaveOutDescriptionWords: 'clearance', leaveOutTitleWords: 'Enterprise',
      seniority: ['Senior', 'Mid-Level', 'Entry-Level'], employmentTypes: ['Full Time'], companies: CHOSEN.join(', '),
    })
    const made = await rowsOf(api, h.searchesSheetId)
    expect(made.map(r => [r['Role title'], r.Country, r.Seniority])).toEqual([
      ['SDR', 'United States', 'Senior, Mid-Level, Entry-Level'],
      ['Engineer Backend', 'United States', 'Senior, Mid-Level, Entry-Level']])
    expect(await paidCalls()).toEqual([])

    // The person clears one row's seniority, and adds a row with no role title.
    const writer = { Authorization: `Bearer ${await makeAccessToken(api, ['read', 'write'], 'e2e filters')}` }
    const [, second] = rowIds(h.searchesSheetId)
    const edit = await api.post(`/api/v1/sheets/${h.searchesSheetId}/rows/update`,
      { headers: writer, data: { updates: [{ row_id: second, data: { Seniority: '' } }] } })
    expect(edit.ok(), await edit.text()).toBeTruthy()
    const add = await api.post(`/api/v1/sheets/${h.searchesSheetId}/rows`,
      { headers: writer, data: { rows: [{ data: { 'Employment type': 'Contract' } }] } })
    expect(add.status(), await add.text()).toBe(201)

    const est = (await (await api.post(`/api/hiring/${h.id}/check`, { data: { estimateOnly: true } })).json())
      .estimate
    // The mock counts the share of its roles each search's filters keep, seniority aside.
    expect(est).toMatchObject({ searches: 2, rolesUpTo: 50,
      matches: { about: 60, counted: 2, capped: false, leftOut: ['seniority'] } })
    const counted = await sentTo('/call/hirebase.jobs.search.count')
    expect(counted.map(b => [b.job_titles, b.experience_levels, b.limit])).toEqual([
      [['Engineer Backend', '-Enterprise'], undefined, 0], [['SDR', '-Enterprise'], undefined, 0]])
    expect(await paidCalls()).toEqual([])

    const res = await api.post(`/api/hiring/${h.id}/check`, { data: { timeZone: 'UTC', maxCostUsd: est.highUsd } })
    const started = await res.json()
    expect(res.ok(), JSON.stringify(started)).toBeTruthy()
    await waitRun(api, started.check.runId, ['completed'])
    await waitAdded(h.searchesSheetId)
    const done = await until(async () => (await (await api.get(`/api/hiring/${h.id}`)).json()).hiring,
      v => v.checks[0].stage === 'done', 'check')
    expect(await sentTo('/call/hirebase.jobs.search')).toEqual([
      { job_titles: ['Engineer Backend', '-Enterprise'], keywords: ['outbound', '-clearance'],
        geo_locations: [{ country: 'United States' }], days_ago: 30, job_types: ['Full Time'],
        company_domains: CHOSEN, limit: 25 },
      { job_titles: ['SDR', '-Enterprise'], keywords: ['outbound', '-clearance'],
        geo_locations: [{ country: 'United States' }], days_ago: 30,
        experience_levels: ['Senior', 'Mid-Level', 'Entry-Level'], job_types: ['Full Time'], company_domains: CHOSEN,
        limit: 25 },
    ])
    const roles = await rowsOf(api, h.rolesSheetId)
    expect(roles).toHaveLength(4)
    expect(done.checks[0]).toMatchObject({ rolesAdded: 4, companiesNew: 4 })
    expect(roles.every(r => !r.Title.includes('Enterprise') && CHOSEN.includes(r.Domain))).toBe(true)
    const billed = (await mockBilling()).filter(b => b.toolId === 'hirebase.jobs.search')
    expect(billed.reduce((n, b) => n + b.costMicro, 0)).toBe(4 * 1500)
    const blank = (await rowsOf(api, h.searchesSheetId))[2]
    expect(blank['Roles found']).toMatch(/^⏭️/)
    await api.dispose()
  })

test('MCP and /api/v1: the same lists snake_case, answered back; a table without them as before', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  await freshTreg(api)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e filters mcp'))
  const made = await call(client, 'hiring_signals', { action: 'create', roles: ['SDR'], country: 'GB',
    seniority: ['senior'], leave_out_title_words: 'intern', companies: ['https://www.Ramp.com'] })
  expect(made).toMatchObject({ searches: 1, seniority: ['Senior'], leave_out_title_words: ['intern'],
    companies: ['ramp.com'], description_words: [], employment_types: [] })
  const est = await call(client, 'hiring_signals', { action: 'check', id: made.id })
  expect(est.matches.note).toBe('The job index\'s free count. It doesn\'t take seniority, so it counts roles at '
    + 'every level and reads higher.')
  expect(await callError(client, 'hiring_signals', { action: 'create', roles: ['SDR'], seniority: ['Boss'] }))
    .toMatch(/^seniority takes Entry-Level, Junior \/ Associate/)
  const plain = await call(client, 'hiring_signals', { action: 'create', roles: ['BDR'] })
  expect('seniority' in plain).toBe(false)
  const plainEst = await call(client, 'hiring_signals', { action: 'check', id: plain.id })
  expect(plainEst.matches.note).toBe('The job index\'s free count, before the place filter.')

  const writer = { Authorization: `Bearer ${await makeAccessToken(api, ['read', 'write'], 'e2e filters rest')}` }
  const rest = await api.post('/api/v1/hiring', { headers: writer,
    data: { roles: ['AE'], employment_types: ['Contract'], description_words: ['Salesforce', '-clearance'] } })
  expect(rest.status()).toBe(201)
  expect(await rest.json()).toMatchObject({ employment_types: ['Contract'], description_words: ['Salesforce'],
    leave_out_description_words: ['clearance'] })
  const bad = await api.post('/api/v1/hiring', { headers: writer, data: { roles: ['AE'], companies: ['ramp'] } })
  expect(bad.status()).toBe(400)
  expect((await bad.json()).error).toBe('Each company in companies is its website, such as ramp.com (got "ramp").')
  expect(await paidCalls()).toEqual([])
  await api.dispose()
})

test('the app: More options make a table with them, its estimate says the count leaves seniority out', async ({
  page, context,
}) => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await freshTreg(api)
  for (const t of await (await api.get('/api/tables')).json()) await api.delete(`/api/tables/${t.id}`)
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/`)
  await page.getByTestId('hiring-open').click()
  const dialog = page.getByTestId('hiring-dialog')
  await dialog.getByLabel('Role titles').fill('SDR')
  await dialog.getByRole('button', { name: 'More options' }).click()
  await dialog.getByLabel('Roles that mention these words come first').fill('outbound, Salesforce')
  await dialog.getByLabel('Leave out roles whose title has').fill('intern')
  await dialog.getByRole('group', { name: 'Seniority' }).getByLabel('Senior', { exact: true }).check()
  await dialog.getByLabel('Only roles at these companies').fill('harborview-health.io')
  await expect(dialog.getByTestId('hiring-more-options')).toContainText('4 set')
  await page.screenshot({ path: process.env.HIRING_SHOTS ? `${process.env.HIRING_SHOTS}/options.png` : undefined })
  await dialog.getByTestId('hiring-create').click()

  const confirm = page.getByTestId('hiring-check-confirm')
  await expect(confirm.getByTestId('hiring-check-matches')).toContainText(
    "It doesn't take seniority, so it counts roles at every level and reads higher.", { timeout: 30_000 })
  await page.screenshot({ path: process.env.HIRING_SHOTS ? `${process.env.HIRING_SHOTS}/confirm.png` : undefined })
  const tables = await (await api.get('/api/tables')).json()
  const sheets = (await (await api.get(`/api/tables/${tables[0].id}`)).json()).sheets as
    Array<{ id: string; name: string }>
  const row = (await rowsOf(api, sheets.find(s => s.name === 'Searches')!.id))[0]
  expect(row).toMatchObject({ 'Role title': 'SDR', Country: 'United States',
    'Description words': 'outbound, Salesforce', 'Title words left out': 'intern', Seniority: 'Senior',
    'Only these companies': 'harborview-health.io', 'Employment type': '', 'Description words left out': '' })
  expect(await paidCalls()).toEqual([])
  await api.dispose()
})
