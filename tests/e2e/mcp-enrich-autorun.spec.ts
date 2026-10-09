import { test, expect } from '@playwright/test'
import { authedApi, makeAccessToken } from './helpers'
import { freshTreg, seedLeadRows } from './helpers-enrich'
import { byName, waitRow } from './helpers-autorun'
import { call, callError, mcpClient, waitMcpRun } from './helpers-mcp'

// Auto-run for agents (plan Features F "Agents and API", H): run_enrichment's
// auto_run and set_auto_run turn it on; appends answer with auto_run (what the
// new rows set off: an enrichment's cost range, an HTTP column's real
// requests); new rows fill on their own; pausing all stops that. Then the
// same over /api/v1.

const COL = 'Work email'
const EMAIL_RUN = {
  tool_id: 'treg.people.email.find', preset: 'verified_email', column_name: COL,
  inputs: { full_name: 'Name', domain: 'Website' },
}
const found = (r: Record<string, string>) => (r[COL] ?? '').startsWith('✅')

test(
  'MCP: auto_run on a run, append_rows says so, new rows fill; pause all; an HTTP column sends requests',
  async () => {
  test.setTimeout(120_000)
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId } = await seedLeadRows(api, [{ Name: 'Maya Chen', Website: 'stripe.com' }])
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e mcp autorun'))

  const started = await call(client, 'run_enrichment', {
    sheet_id: sheetId, ...EMAIL_RUN, auto_run: { enabled: true, daily_cap_usd: 2 },
  })
  expect(started.auto_run).toMatchObject({ column: COL, kind: 'enrichment', enabled: true, daily_cap_usd: 2 })
  await waitMcpRun(client, started.run_id, ['completed'])

  const appended = await call(
    client, 'append_rows', { sheet_id: sheetId, rows: [{ Name: 'Leo Martins', Website: 'notion.so' }] },
  )
  expect(appended.auto_run).toHaveLength(1)
  expect(appended.auto_run[0]).toMatchObject({ column: COL, kind: 'enrichment', rows: 1, sends_requests: false })
  expect(appended.auto_run[0].estimated_usd.high).toBeGreaterThan(0)
  await waitRow(api, sheetId, byName('Leo Martins'), found)

  // Pause every auto-run on the sheet: a new row waits.
  const paused = await call(client, 'set_auto_run', { sheet_id: sheetId, paused: true })
  expect(paused.auto_run[0].paused_reason).toBe('user')
  expect(paused.daily_limit.limit_usd).toBe(10)
  const later = await call(
    client, 'append_rows', { sheet_id: sheetId, rows: [{ Name: 'Ada Lovelace', Website: 'figma.com' }] },
  )
  expect(later.auto_run[0].paused).toBe('user')
  await new Promise(r => setTimeout(r, 2500))
  const rows = (await call(client, 'read_rows', { sheet_id: sheetId })).rows
  expect(rows.find((r: any) => r.data.Name === 'Ada Lovelace').data[COL] ?? '').toBe('')
  await call(client, 'set_auto_run', { sheet_id: sheetId, paused: false })
  await waitRow(api, sheetId, byName('Ada Lovelace'), found)

  // Arguments that mean nothing are refused.
  expect(await callError(client, 'set_auto_run', { sheet_id: sheetId, column: COL, enabled: true, paused: true }))
    .toContain('not both')
  expect(await callError(client, 'set_auto_run', { sheet_id: sheetId, column: 'Name', enabled: true }))
    .toContain('Run this column once first')

  // An HTTP API column's auto-run: the append says it sends real requests.
  const http = await call(client, 'run_http_enrichment', {
    sheet_id: sheetId, url: 'https://jsonplaceholder.typicode.com/users/1?q={{Name}}',
    response_mapping: [{ json_path: '$.name', column_name: 'Placeholder' }], master_column_name: 'Push',
  })
  await waitMcpRunHttp(client, http.run_id)
  const on = await call(
    client, 'set_auto_run', { sheet_id: sheetId, column: 'Push', enabled: true, daily_row_cap: 3 },
  )
  expect(on.auto_run.find((a: any) => a.column === 'Push')).toMatchObject({
    kind: 'http', sends_requests: true, daily_row_cap: 3,
  })
  const third = await call(
    client, 'append_rows', { sheet_id: sheetId, rows: [{ Name: 'Grace Hopper', Website: 'linear.app' }] },
  )
  expect(third.auto_run.find((a: any) => a.column === 'Push')).toMatchObject({
    sends_requests: true, estimated_usd: null,
  })
  await waitRow(api, sheetId, byName('Grace Hopper'), r => (r.Push ?? '').startsWith('✅'), 30_000)
  await call(client, 'set_auto_run', { sheet_id: sheetId, column: 'Push', enabled: false })
  await api.dispose()
})

async function waitMcpRunHttp(client: Awaited<ReturnType<typeof mcpClient>>, runId: string) {
  await expect.poll(async () => (await call(client, 'get_run_status', { run_type: 'http', run_id: runId })).status,
    { timeout: 30_000 }).toBe('completed')
}

test('/api/v1: enrichment-auto-run, and the append answers auto_run', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId } = await seedLeadRows(api, [{ Name: 'Maya Chen', Website: 'stripe.com' }])
  const headers = { Authorization: `Bearer ${await makeAccessToken(api, ['read', 'write', 'run'], 'e2e v1 autorun')}` }
  const est = await api.post(`/api/v1/sheets/${sheetId}/enrichment-runs`, {
    headers, data: { ...EMAIL_RUN, estimate_only: true },
  })
  expect(est.status()).toBe(200)
  // REST bodies are checked too: a camelCase estimate is refused, nothing starts.
  const typo = await api.post(`/api/v1/sheets/${sheetId}/enrichment-runs`, {
    headers, data: { ...EMAIL_RUN, estimateOnly: true },
  })
  expect(typo.status()).toBe(400)
  expect((await typo.json()).error).toContain('did you mean estimate_only?')
  expect((await est.json()).daily_limit.limit_usd).toBe(10)
  const start = await api.post(`/api/v1/sheets/${sheetId}/enrichment-runs`, { headers, data: EMAIL_RUN })
  expect(start.status(), await start.text()).toBe(202)
  const runId = (await start.json()).run_id
  await expect.poll(async () => (await (await api.get(`/api/v1/http-runs/${runId}`, { headers })).json()).status,
    { timeout: 30_000 }).toBe('completed')
  const status = await (await api.get(`/api/v1/http-runs/${runId}`, { headers })).json()
  expect(status.cost_usd).toBeGreaterThan(0)
  expect(status.enrichment.tool_name).toBe('Verified work email')
  const results = await (await api.get(`/api/v1/http-runs/${runId}/results?answers=true`, { headers })).json()
  expect(results.results[0].answer).toBeTruthy()

  const put = await api.put(`/api/v1/sheets/${sheetId}/enrichment-auto-run`, {
    headers,
    data: { column: COL, enabled: true, daily_cap_usd: 1, where: [{ column: 'Website', operator: 'not_empty' }] },
  })
  expect(put.ok(), await put.text()).toBeTruthy()
  expect((await put.json()).auto_run[0].where).toEqual([{ column: 'Website', operator: 'not_empty', value: '' }])
  const append = await api.post(`/api/v1/sheets/${sheetId}/rows`, {
    headers, data: { rows: [{ data: { Name: 'Leo Martins', Website: 'notion.so' } }] },
  })
  expect(append.status()).toBe(201)
  expect((await append.json()).auto_run[0]).toMatchObject({ column: COL, rows: 1 })
  await waitRow(api, sheetId, byName('Leo Martins'), found)
  const off = await api.put(
    `/api/v1/sheets/${sheetId}/enrichment-auto-run`, { headers, data: { column: COL, enabled: false } },
  )
  expect((await off.json()).auto_run[0].enabled).toBe(false)
  const quiet = await api.post(`/api/v1/sheets/${sheetId}/rows`, {
    headers, data: { rows: [{ data: { Name: 'Ada Lovelace', Website: 'figma.com' } }] },
  })
  expect((await quiet.json()).auto_run).toBeUndefined()
  await api.dispose()
})
