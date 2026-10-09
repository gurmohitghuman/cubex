import { test, expect } from '@playwright/test'
import { authedApi, makeAccessToken } from './helpers'
import { mockTreg } from './helpers-treg'
import { expectBilledOnce, freshTreg, ledger, readDb, seedLeadRows } from './helpers-enrich'
import { call, callError, mcpClient, waitMcpRun } from './helpers-mcp'

// Enrichments through MCP (plan Features H; Verification 11 and 14's MCP
// part): search, read a tool, estimate_only creates nothing and carries the
// daily limit, a run, its status with cost, per-row results with cost and
// provider, idempotent retries, and a column from stored answers.

const LEADS = [
  { Name: 'Maya Chen', Website: 'https://stripe.com' }, { Name: 'Leo Martins', Website: 'notion.so' },
  { Name: 'Ava Patel', Website: 'figma.com' },
]
const EMAIL_RUN = {
  tool_id: 'treg.people.email.find', preset: 'verified_email', column_name: 'Work email',
  inputs: { full_name: 'Name', domain: 'Website' },
}
const tregCalls = async () => (await mockTreg.requests()).filter(r => r.path.startsWith('/call/')).length
const runsOn = (sheetId: string): number =>
  readDb(db => db.prepare('SELECT COUNT(*) FROM http_runs WHERE sheet_id = ?').pluck().get(sheetId))

// Idempotency keys share the account's ledger with every other spec: keep them unique.
const KEY = `mcp-enrich-${Date.now()}`

test('search, estimate_only creates nothing, run, status cost (V11, V14)', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId } = await seedLeadRows(api, LEADS)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e mcp enrich'))

  const found = await call(client, 'search_enrichments', { query: 'work email' })
  expect(found.tools.map((t: any) => t.tool_id)).toContain('treg.people.email.find')
  const popular = await call(client, 'search_enrichments', {})
  expect(popular.popular).toBe(true)
  const tool = await call(client, 'get_enrichment', { tool_id: 'treg.people.email.find' })
  expect(tool.inputs.map((i: any) => i.name)).toEqual(expect.arrayContaining(['domain', 'full_name']))
  expect(tool.presets[0].preset).toBe('verified_email')
  expect(tool.providers.length).toBeGreaterThan(1)
  expect(tool.has_treg_key).toBe(true)

  const before = (await call(client, 'get_sheet', { sheet_id: sheetId })).columns
  const est = await call(client, 'run_enrichment', { sheet_id: sheetId, ...EMAIL_RUN, estimate_only: true })
  expect(est.estimate_only).toBe(true)
  expect(est.rows_to_process).toBe(3)
  expect(est.output_columns).toEqual(['Email', 'Email status', 'Found by'])
  expect(est.estimated_cost_usd.high).toBeGreaterThanOrEqual(est.estimated_cost_usd.low)
  expect(est.daily_limit).toEqual({
    limit_usd: 10, used_today_usd: expect.any(Number), remaining_usd: expect.any(Number),
  })
  expect(est.treg_balance_usd).toBeGreaterThan(0)
  // Nothing was created: no column, no run, no treg call.
  expect((await call(client, 'get_sheet', { sheet_id: sheetId })).columns).toEqual(before)
  expect(runsOn(sheetId)).toBe(0)
  expect(await tregCalls()).toBe(0)

  // A bad argument is refused before anything starts.
  expect(await callError(client, 'run_enrichment', { sheet_id: sheetId, ...EMAIL_RUN, inputs: { nope: 'Name' } }))
    .toContain('no input "nope"')
  expect(await callError(client, 'run_enrichment', {
    sheet_id: sheetId, tool_id: 'treg.companies.enrich', column_name: 'Company', inputs: { domain: 'Website' },
  })).toContain('Pick the outputs')
  // A misspelled estimate is refused, never run (the schema is strict).
  const typo = await client.callTool({
    name: 'run_enrichment', arguments: { sheet_id: sheetId, ...EMAIL_RUN, estimateOnly: true },
  })
  expect(typo.isError).toBeTruthy()
  // "Only run if" narrows the rows an estimate counts.
  const narrowed = await call(client, 'run_enrichment', {
    sheet_id: sheetId, ...EMAIL_RUN, estimate_only: true,
    where: [{ column: 'Name', operator: 'contains', value: 'Maya' }],
  })
  expect(narrowed.rows_to_process).toBe(1)
  expect(await callError(client, 'run_enrichment', {
    sheet_id: sheetId, ...EMAIL_RUN, where: [{ column: 'Name', operator: 'eq', value: 'Nobody' }],
  })).toContain('No rows here pass "Only run if"')
  expect(runsOn(sheetId)).toBe(0)
  expect(await tregCalls()).toBe(0)

  const started = await call(client, 'run_enrichment', { sheet_id: sheetId, ...EMAIL_RUN, idempotency_key: KEY })
  expect(started.run_type).toBe('enrichment')
  expect(started.rows_in_scope).toBe(3)
  expect(started.daily_limit.limit_usd).toBe(10)
  const done = await waitMcpRun(client, started.run_id, ['completed'])
  expect(done.enrichment.tool_id).toBe('treg.people.email.find')
  expect(done.enrichment.tool_name).toBe('Verified work email')
  const spent = ledger(started.run_id).reduce((s, c) => s + (c.cost_micro ?? 0), 0) / 1e6
  expect(done.cost_usd).toBeCloseTo(spent, 6)
  expect(done.cost_usd).toBeGreaterThan(0)
  expect(done.daily_limit.used_today_usd).toBeGreaterThanOrEqual(spent - 1e-9)
  await expectBilledOnce([started.run_id])

  // The same key and arguments replay the run; other arguments under it are refused.
  const replay = await call(client, 'run_enrichment', { sheet_id: sheetId, ...EMAIL_RUN, idempotency_key: KEY })
  expect(replay.replayed).toBe(true)
  expect(replay.run_id).toBe(started.run_id)
  expect(await callError(client, 'run_enrichment', {
    sheet_id: sheetId, ...EMAIL_RUN, column_name: 'Other', idempotency_key: KEY,
  })).toContain('different arguments')

  const results = await call(client, 'get_run_results', {
    run_type: 'enrichment', run_id: started.run_id, status_filter: 'all',
  })
  expect(results.results).toHaveLength(3)
  for (const r of results.results) {
    expect(r.extracted_fields['Work email']).toMatch(/^(✅|⏭️)/)
    expect(typeof r.cost_usd).toBe('number')
  }
  expect(results.results.some((r: any) => typeof r.found_by === 'string' && r.found_by)).toBe(true)
  const listed = await call(client, 'list_runs', { sheet_id: sheetId })
  expect(listed.runs[0].enrichment.tool_id).toBe('treg.people.email.find')
  expect(listed.runs[0].cost_usd).toBeCloseTo(spent, 6)
  await api.dispose()
})

test('a column from stored answers: include_answers shows the paths, the column fills for free', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId } = await seedLeadRows(api, LEADS)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e mcp field'))
  const started = await call(client, 'run_enrichment', {
    sheet_id: sheetId, tool_id: 'treg.companies.enrich', column_name: 'Company data',
    inputs: { domain: 'Website' }, outputs: [{ field: 'name', column_name: 'Company name' }],
  })
  await waitMcpRun(client, started.run_id, ['completed'])
  const page = await call(client, 'get_run_results', {
    run_type: 'enrichment', run_id: started.run_id, status_filter: 'completed', include_answers: true, limit: 50,
  })
  expect(page.results.length).toBeLessThanOrEqual(10)
  const hit = page.results.find((r: any) => r.answer?.output?.industry)
  expect(hit, 'an answer with an industry').toBeTruthy()
  const callsBefore = await tregCalls()

  const added = await call(client, 'add_enrichment_field', {
    sheet_id: sheetId, column: 'Company data', json_path: '$.output.industry', column_name: 'Industry',
    row_id: hit.row_id,
  })
  expect(added.column).toBe('Industry')
  await expect.poll(async () => (await call(client, 'get_sheet', { sheet_id: sheetId })).filling_columns,
    { timeout: 15_000 }).toEqual([])
  const rows = (await call(client, 'read_rows', { sheet_id: sheetId })).rows
  expect(rows.find((r: any) => r.id === hit.row_id).data.Industry).toBe(String(hit.answer.output.industry))
  expect(await tregCalls()).toBe(callsBefore)
  // A path already a column is refused.
  expect(await callError(client, 'add_enrichment_field', {
    sheet_id: sheetId, column: 'Company data', json_path: '$.output.industry', column_name: 'Industry 2',
  })).toContain('already a column')
  await api.dispose()
})
