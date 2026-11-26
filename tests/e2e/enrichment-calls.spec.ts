import { test, expect } from '@playwright/test'
import { BASE, authedApi, makeAccessToken } from './helpers'
import { freshTreg } from './helpers-enrich'
import { mcpClient, call, callError } from './helpers-mcp'

// One enrichment tool called on items without a sheet (services/enrich-call.ts), against the mock treg:
// run_enrichment with items prices by default and makes nothing, and refuses a sheet's arguments beside items (and
// items' beside sheet_id); a ceiling it could pass refuses it before anything runs;
// started, it is an enrichment run on a working table no list shows, and get_run_results gives each item's row
// (row_index is the item); a tool with a "status" field runs too, and Settings' spend card shows what the calls
// spent as "A call without a sheet". REST prices it (estimate_only), refuses an input the tool lacks, and needs
// "run".
const TOOL = 'treg.people.email.find'

test('an enrichment called on items: priced, refused over a ceiling, run without a sheet', async ({
  page, context,
}) => {
  test.setTimeout(120_000)
  const api = await authedApi()
  await freshTreg(api)
  const token = await makeAccessToken(api, ['read', 'write', 'run'], 'enrichment-calls')
  const client = await mcpClient(token)
  const tables = async () => (await call(client, 'list_tables', {})).tables.length
  const before = await tables()
  const items = [{ full_name: 'Ada Lovelace', domain: 'acme.com' }, { full_name: 'Grace Hopper', domain: 'navy.mil' }]

  const est = await call(client, 'run_enrichment', { tool_id: TOOL, items })
  expect(est.estimate_only).toBe(true)
  expect(est.estimate.rows_to_process).toBe(2)
  expect(est.run_id).toBeUndefined()
  expect(await tables()).toBe(before)
  // The name v0.8.45 had, called from an older tool list: told what replaced it.
  expect(await callError(client, 'call_enrichment', { tool_id: TOOL, items })).toContain('renamed to run_enrichment')
  expect(await callError(client, 'run_enrichment', { tool_id: TOOL, items, column_name: 'Email' }))
    .toContain('column_name go with sheet_id')
  expect(await callError(client, 'run_enrichment', { tool_id: TOOL, sheet_id: 'any', column_name: 'Email',
    max_cost_usd: 1 })).toContain('max_cost_usd go with items')
  expect(await callError(client, 'run_enrichment', { tool_id: TOOL, items, estimate_only: false,
    max_cost_usd: 0.000001 })).toContain('more than max_cost_usd')
  expect(await callError(client, 'run_enrichment', { tool_id: TOOL, items: [{ nope: 'x' }] }))
    .toContain('isn\'t an input of this tool')
  expect(await tables()).toBe(before)

  const started = await call(client, 'run_enrichment', { tool_id: TOOL, items, estimate_only: false,
    max_cost_usd: 10 })
  expect(started.items).toBe(2)
  expect(await tables()).toBe(before)
  await expect.poll(async () => (await call(client, 'get_run_status', { run_type: 'enrichment',
    run_id: started.run_id, wait_seconds: 5 })).status, { timeout: 60_000 }).toMatch(/completed|failed/)
  const results = await call(client, 'get_run_results', { run_type: 'enrichment', run_id: started.run_id,
    status_filter: 'all' })
  expect(results.results.map((r: any) => r.row_index).sort()).toEqual([0, 1])
  expect(await tables()).toBe(before)

  // An email check: its tool answers a "status" field, so the status column takes another name.
  const checked = await call(client, 'run_enrichment', { tool_id: 'treg.people.email.verify',
    items: [{ email: 'ada@acme.com' }], estimate_only: false, max_cost_usd: 10 })
  expect(checked.status_column).toBe('Status 2')
  expect(checked.output_columns).toContain('status')
  await expect.poll(async () => (await call(client, 'get_run_status', { run_type: 'enrichment',
    run_id: checked.run_id, wait_seconds: 5 })).status, { timeout: 60_000 }).toMatch(/completed|failed/)
  expect(await tables()).toBe(before)

  // What the calls spent: one line for calls in Settings, never the working table's name.
  const spend = await (await api.get(`${BASE}/api/enrich/spend?days=30`)).json()
  expect(spend.columns.filter((c: any) => c.call)).toHaveLength(1)
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/settings/http-enrichment`)
  const card = page.getByTestId('enrich-spend-card')
  await expect(card).toContainText('A call without a sheet', { timeout: 15_000 })
  await expect(card).not.toContainText('Enrichment call ')

  const auth = { Authorization: `Bearer ${token}` }
  const priced = await api.post(`${BASE}/api/v1/enrichments/${TOOL}/calls`, { headers: auth,
    data: { items, estimate_only: true } })
  expect(priced.status()).toBe(200)
  expect((await priced.json()).estimate.rows_to_process).toBe(2)
  expect((await api.post(`${BASE}/api/v1/enrichments/${TOOL}/calls`, { headers: auth,
    data: { items: [{ nope: 'x' }] } })).status()).toBe(400)
  const readOnly = await makeAccessToken(api, ['read'], 'enrichment-calls-read')
  expect((await api.post(`${BASE}/api/v1/enrichments/${TOOL}/calls`, {
    headers: { Authorization: `Bearer ${readOnly}` }, data: { items } })).status()).toBe(403)
})
