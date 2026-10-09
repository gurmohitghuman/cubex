import { test, expect } from '@playwright/test'
import { authedApi, makeAccessToken } from './helpers'
import { freshTreg, rowsOf, seedCsv } from './helpers-enrich'
import { companiesCsv, waitAdded } from './helpers-list'
import { call, callError, mcpClient, waitMcpRun } from './helpers-mcp'

// A list job for agents, as the drawer does it (the user's M8 decision: the
// fields to keep come from real results): a test of 5 rows whose results wait
// for fields, the fields those results have, a pick that adds their rows,
// then the rest with the same fields. Through MCP, then through /api/v1.

const COMPANIES: Array<[string, string]> = [
  ['Stripe', 'https://stripe.com'], ['Notion', 'notion.so'], ['Figma', 'figma.com'], ['Linear', 'linear.app'],
  ['Vercel', 'vercel.com'], ['Ramp', 'ramp.com'], ['Retool', 'retool.com'],
]
const PEOPLE = {
  tool_id: 'treg.people.search', column_name: 'People', inputs: { company_domain: 'Website' },
}
const LIST = { provider: 'quickenrich', results_per_row: 3, copy_columns: [{ from: 'Company' }] }
const FIELDS = [
  { path: '$.first_name', column_name: 'First name' }, { path: '$.employee_linkedin', column_name: 'LinkedIn' },
]

test('MCP: test 5 rows, read the fields, add those rows, run the rest', async () => {
  test.setTimeout(120_000)
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId } = await seedCsv(api, companiesCsv(COMPANIES))
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e mcp list'))

  const tool = await call(client, 'get_enrichment', { tool_id: 'treg.people.search' })
  expect(tool.adds_rows).toBe(true)
  expect(tool.outputs).toEqual([])
  // A full run needs fields, which come from a test's results.
  expect(await callError(client, 'run_enrichment', {
    sheet_id: sheetId, ...PEOPLE, list: { new_sheet_name: 'People', ...LIST },
  })).toContain('test: true')
  const est = await call(client, 'run_enrichment', {
    sheet_id: sheetId, ...PEOPLE, test: true, estimate_only: true, list: { new_sheet_name: 'People', ...LIST },
  })
  expect(est.rows_to_process).toBe(5)
  expect(est.list).toMatchObject({ destination: { new_sheet_name: 'People' }, adds_up_to_rows: 15, results_per_row: 3 })
  expect((await call(client, 'list_tables', {})).tables[0].sheets).toHaveLength(1)

  const started = await call(client, 'run_enrichment', {
    sheet_id: sheetId, ...PEOPLE, test: true, list: { new_sheet_name: 'People', ...LIST },
  })
  expect(started.destination_sheet_id).toBeTruthy()
  const tested = await waitMcpRun(client, started.run_id, ['completed'])
  expect(tested.enrichment.list.waiting_for_fields).toEqual({ rows: 5, results: 15 })
  expect(tested.enrichment.list.fields).toBeNull()
  const source = await rowsOf(api, sheetId)
  expect(source.filter(r => r.People === '➕ 3 results, waiting for fields')).toHaveLength(5)

  const fields = await call(client, 'get_list_fields', { sheet_id: sheetId, column: 'People' })
  expect(fields.waiting_for_fields).toEqual({ rows: 5, results: 15 })
  const first = fields.fields.find((f: any) => f.path === '$.first_name')
  expect(first).toMatchObject({ filled: 15 })
  expect(first.sample).toBeTruthy()

  expect(await callError(client, 'add_list_rows', {
    sheet_id: sheetId, column: 'People', fields: FIELDS, dedupe_path: '$.title',
  })).toContain('dedupe_path')
  const picked = await call(client, 'add_list_rows', {
    sheet_id: sheetId, column: 'People', fields: FIELDS, dedupe_path: '$.employee_linkedin',
  })
  expect(picked.source_rows_released).toBe(5)
  await waitAdded(sheetId)
  expect(await rowsOf(api, started.destination_sheet_id)).toHaveLength(15)

  const rest = await call(client, 'control_run', {
    run_type: 'enrichment', run_id: started.run_id, action: 'rerun', mode: 'empty',
  })
  expect(rest.rows_in_scope).toBe(2)
  const done = await waitMcpRun(client, rest.run_id, ['completed'])
  expect(done.enrichment.list.fields).toEqual(FIELDS)
  await waitAdded(sheetId)
  const dest = await rowsOf(api, started.destination_sheet_id)
  expect(dest).toHaveLength(21)
  expect(dest.every(r => r['First name'] && r.LinkedIn && r.Company)).toBe(true)
  expect((await rowsOf(api, sheetId)).filter(r => r.People === '✅ 3 rows added')).toHaveLength(7)
  await api.dispose()
})

test('/api/v1: the same list flow over REST', async () => {
  test.setTimeout(120_000)
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId } = await seedCsv(api, companiesCsv(COMPANIES.slice(0, 6)))
  const token = await makeAccessToken(api, ['read', 'write', 'run'], 'e2e v1 list')
  const headers = { Authorization: `Bearer ${token}` }
  const v1 = (path: string) => `/api/v1${path}`

  const search = await api.get(v1('/enrichments?q=people'), { headers })
  expect(search.ok()).toBeTruthy()
  expect((await search.json()).tools.some((t: any) => t.adds_rows)).toBe(true)
  const detail = await api.get(v1('/enrichments/treg.people.search'), { headers })
  expect((await detail.json()).adds_rows).toBe(true)

  const start = await api.post(v1(`/sheets/${sheetId}/enrichment-runs`), {
    headers, data: { ...PEOPLE, test: true, list: { new_sheet_name: 'People', ...LIST } },
  })
  expect(start.status(), await start.text()).toBe(202)
  const run = await start.json()
  await expect.poll(async () => (await (await api.get(v1(`/http-runs/${run.run_id}`), { headers })).json()).status,
    { timeout: 30_000 }).toBe('completed')
  const status = await (await api.get(v1(`/http-runs/${run.run_id}`), { headers })).json()
  expect(status.enrichment.list.waiting_for_fields.rows).toBe(5)

  const read = await api.get(v1(`/sheets/${sheetId}/enrichment-list-fields?column=People`), { headers })
  expect((await read.json()).fields.map((f: any) => f.path)).toContain('$.first_name')
  const pick = await api.post(v1(`/sheets/${sheetId}/enrichment-list-fields`), {
    headers, data: { column: 'People', fields: FIELDS },
  })
  expect(pick.ok(), await pick.text()).toBeTruthy()
  expect((await pick.json()).source_rows_released).toBe(5)
  await waitAdded(sheetId)
  const rest = await api.post(v1(`/http-runs/${run.run_id}/rerun`), { headers, data: { mode: 'empty' } })
  expect(rest.status(), await rest.text()).toBe(202)
  const restRun = await rest.json()
  await expect.poll(async () => (await (await api.get(v1(`/http-runs/${restRun.run_id}`), { headers })).json()).status,
    { timeout: 30_000 }).toBe('completed')
  await waitAdded(sheetId)
  expect(await rowsOf(api, run.destination_sheet_id)).toHaveLength(18)
  await api.dispose()
})
