import { test, expect, request as pwRequest, type Page, type APIRequestContext } from '@playwright/test'
import { authedApi, importCsv, makeAccessToken, BASE } from './helpers'
import { mcpClient, call, callError } from './helpers-mcp'

// The "is any of" value picker (top values with counts, narrowing, typed
// values), and read_rows / REST rows/query extras (group_by + aggregates, a
// value out of a JSON cell, starts_with / ends_with).

const shots = process.env.E2E_SHOTS
const snap = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }) }

async function freshSheet(api: APIRequestContext, csv: string) {
  const existing = await (await api.get('/api/tables')).json()
  if (Array.isArray(existing)) for (const t of existing) await api.delete(`/api/tables/${t.id}`)
  const table = await (await api.post('/api/tables', { data: { name: `Search ${Date.now()}` } })).json()
  const sheetId = table.sheets[0].id as string
  expect((await importCsv(api, sheetId, csv, { replaceData: true })).ok()).toBeTruthy()
  await expect.poll(async () => (await (await api.get(`/api/sheets/${sheetId}?limit=1`)).json()).data.totalRows,
    { timeout: 30_000 }).toBeGreaterThan(0)
  return { tableId: table.id as string, sheetId }
}

test('"is any of" offers the column\'s values with counts, narrows them, and takes typed values',
  async ({ page, context }) => {
  test.setTimeout(120_000)
  const api = await authedApi()
  const industries = ['SaaS', 'Fintech', 'saas', 'Retail', '', ' SAAS ', 'Fintech', 'Biotech']
  const { tableId, sheetId } = await freshSheet(api,
    ['Name,Industry', ...industries.map((v, i) => `n${i},${v}`)].join('\n'))
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}/${sheetId}`)
  await page.locator('.ag-center-cols-container .ag-row').first().waitFor()
  await page.locator('.ag-header-cell').filter({ hasText: 'Industry' }).first().locator('.ag-header-cell-text').click()
  await page.getByLabel('Filter condition').selectOption('any_of')
  const picker = page.getByTestId('value-picker')
  await expect(picker.locator('label')).toHaveCount(5)
  const row = (label: string) => picker.locator('label').filter({ hasText: label })
  await expect(row('SAAS')).toContainText('3')
  await expect(row('Fintech')).toContainText('2')
  await expect(row('(empty)')).toContainText('1')
  await expect(page.getByTestId('value-picker-note')).toHaveText('4 different values.')
  await snap(page, 'value-picker')
  await picker.getByPlaceholder('Search or type a value…').fill('tech')
  await expect(picker.locator('label')).toHaveCount(2)
  await row('Fintech').locator('input').check()
  await picker.getByPlaceholder('Search or type a value…').fill('Other')
  await picker.getByPlaceholder('Search or type a value…').press('Enter')
  await expect(row('Other')).toHaveCount(1)
  await page.getByTitle('Apply filter').click()
  await expect.poll(async () => (await api.get(`/api/sheets/${sheetId}?limit=50`).then(r => r.json())).sheet
    .column_filters).toBe(JSON.stringify({ Industry: { type: 'any_of', values: ['Fintech', 'Other'] } }))
  await expect(page.locator('.ag-center-cols-container .ag-row')).toHaveCount(2)
})

test('read_rows and rows/query: group_by + aggregates, a value out of a JSON cell, starts_with', async () => {
  const api = await authedApi()
  const csv = ['Industry,Revenue,Response',
    'SaaS,"1,000","{""data"":{""emails"":[""a@x.com""]}}"',
    'saas,500,"{""data"":{""emails"":[""b@x.com"",""c@x.com""]}}"',
    'Fintech,N/A,not json',
    'Fintech,250,"{""data"":{}}"'].join('\n')
  const { sheetId } = await freshSheet(api, csv)
  const token = await makeAccessToken(api, ['read'], 'search-query')
  const v1 = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${token}` } })
  const query = (body: Record<string, unknown>) => v1.post(`/api/v1/sheets/${sheetId}/rows/query`, { data: body })

  const grouped = await (await query({ group_by: ['Industry'],
    aggregates: [{ op: 'sum', column: 'Revenue' }, { op: 'avg', column: 'Revenue' }] })).json()
  // Equal counts: by value.
  expect(grouped).toMatchObject({ rows_matched: 4, group_count: 2, truncated: false, groups: [
    { group: { Industry: 'Fintech' }, count: 2, values: { 'sum(Revenue)': 250, 'avg(Revenue)': 250 } },
    { group: { Industry: 'SaaS' }, count: 2, values: { 'sum(Revenue)': 1500, 'avg(Revenue)': 750 } },
  ] })
  const picked = await (await query({ columns: ['Industry',
    { column: 'Response', path: ['data', 'emails', 1], as: 'Second email' }] })).json()
  expect(picked.rows.map((r: { data: unknown }) => r.data)).toEqual([
    { Industry: 'SaaS', 'Second email': null }, { Industry: 'saas', 'Second email': 'c@x.com' },
    { Industry: 'Fintech', 'Second email': null }, { Industry: 'Fintech', 'Second email': null }])
  const fin = await (await query({ where: [{ column: 'Industry', operator: 'starts_with', value: 'FIN' },
    { column: 'Revenue', operator: 'ends_with', value: '50' }], return_mode: 'count' })).json()
  expect(fin.count).toBe(1)
  const refused = await query({ group_by: ['Industry'], cursor: 0 })
  expect(refused.status()).toBe(400)
  expect((await refused.json()).error).toMatch(/answer groups, not rows/)

  const client = await mcpClient(token)
  const mcp = await call(client, 'read_rows', { sheet_id: sheetId, group_by: ['Industry'],
    aggregates: [{ op: 'count', column: 'Response' }] })
  expect(mcp.groups.map((g: { values: Record<string, number> }) => g.values['count(Response)'])).toEqual([2, 2])
  const first = await call(client, 'read_rows', { sheet_id: sheetId, limit: 1,
    columns: [{ column: 'Response', path: ['data', 'emails', 0] }] })
  expect(first.rows[0].data).toEqual({ 'Response.data.emails.0': 'a@x.com' })
  expect(await callError(client, 'read_rows', { sheet_id: sheetId, group_by: ['Nope'] })).toMatch(/Unknown column/)
})
