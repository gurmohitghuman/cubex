import { test, expect } from '@playwright/test'
import { BASE, authedApi, makeAccessToken } from './helpers'
import { freshTreg } from './helpers-enrich'
import { mcpClient, call, callError } from './helpers-mcp'

// One enrichment tool called on items without a sheet (services/enrich-call.ts), against the mock treg:
// call_enrichment prices by default and makes nothing; a ceiling it could pass refuses it before anything runs;
// started, it is an enrichment run on a working table no list shows, and get_run_results gives each item's row
// (row_index is the item). REST prices it (estimate_only), refuses an input the tool lacks, and needs "run".
const TOOL = 'treg.people.email.find'

test('an enrichment called on items: priced, refused over a ceiling, run without a sheet', async () => {
  test.setTimeout(120_000)
  const api = await authedApi()
  await freshTreg(api)
  const token = await makeAccessToken(api, ['read', 'write', 'run'], 'enrichment-calls')
  const client = await mcpClient(token)
  const tables = async () => (await call(client, 'list_tables', {})).tables.length
  const before = await tables()
  const items = [{ full_name: 'Ada Lovelace', domain: 'acme.com' }, { full_name: 'Grace Hopper', domain: 'navy.mil' }]

  const est = await call(client, 'call_enrichment', { tool_id: TOOL, items })
  expect(est.estimate_only).toBe(true)
  expect(est.estimate.rows_to_process).toBe(2)
  expect(est.run_id).toBeUndefined()
  expect(await tables()).toBe(before)
  expect(await callError(client, 'call_enrichment', { tool_id: TOOL, items, estimate_only: false,
    max_cost_usd: 0.000001 })).toContain('more than max_cost_usd')
  expect(await callError(client, 'call_enrichment', { tool_id: TOOL, items: [{ nope: 'x' }] }))
    .toContain('isn\'t an input of this tool')
  expect(await tables()).toBe(before)

  const started = await call(client, 'call_enrichment', { tool_id: TOOL, items, estimate_only: false,
    max_cost_usd: 10 })
  expect(started.items).toBe(2)
  expect(await tables()).toBe(before)
  await expect.poll(async () => (await call(client, 'get_run_status', { run_type: 'enrichment',
    run_id: started.run_id, wait_seconds: 5 })).status, { timeout: 60_000 }).toMatch(/completed|failed/)
  const results = await call(client, 'get_run_results', { run_type: 'enrichment', run_id: started.run_id,
    status_filter: 'all' })
  expect(results.results.map((r: any) => r.row_index).sort()).toEqual([0, 1])
  expect(await tables()).toBe(before)

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
