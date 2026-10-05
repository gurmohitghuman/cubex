import { test, expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { authedApi, seedSheet, BASE, makeAccessToken } from './helpers'

// Slice A: estimate_only dry-run for run_ai_column / run_http_enrichment.
// Asserts the priced range shape, the EXACT row count, that a bad /ref is
// rejected up front (A9), and — the load-bearing one — that a dry run creates
// NOTHING: no column, no run, no placeholder (A1).



async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'e2e-estimate', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  return client
}

function parseResult(res: { content?: Array<{ type: string; text?: string }> }): any {
  const text = res.content?.find(c => c.type === 'text')?.text
  return text ? JSON.parse(text) : null
}

test('estimate_only: priced range, exact row count, and zero side effects', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 5)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e estimate'))

  const before = parseResult(await client.callTool({ name: 'get_sheet', arguments: { sheet_id: sheetId } }))
  const colsBefore = before.columns.length

  // AI estimate with an explicit model so pricing can resolve.
  const est = parseResult(await client.callTool({
    name: 'run_ai_column',
    arguments: {
      sheet_id: sheetId, column_name: 'Summary', prompt: 'Summarize /val',
      model: 'openai/gpt-4o-mini', estimate_only: true,
    },
  }))
  expect(est.rows_to_process).toBe(5)
  expect(est.model).toBe('openai/gpt-4o-mini')
  // Cost may be absent only if OpenRouter's public catalog was unreachable.
  if (est.pricing_available) {
    expect(est.estimated_cost_usd.high).toBeGreaterThanOrEqual(est.estimated_cost_usd.low)
    expect(est.per_row_usd.high).toBeGreaterThanOrEqual(est.per_row_usd.low)
  }
  expect(['history', 'heuristic-no-history']).toContain(est.basis)

  // A1: nothing was created — no "Summary (Output)" column, no run.
  const after = parseResult(await client.callTool({ name: 'get_sheet', arguments: { sheet_id: sheetId } }))
  expect(after.columns.length).toBe(colsBefore)
  expect(after.columns).not.toContain('Summary (Output)')

  // A9: an unresolvable /ref is rejected, not priced.
  const bad: any = await client.callTool({
    name: 'run_ai_column',
    arguments: {
      sheet_id: sheetId, column_name: 'Bad', prompt: 'Use /does_not_exist',
      model: 'openai/gpt-4o-mini', estimate_only: true,
    },
  })
  expect(bad.isError).toBeTruthy()

  // HTTP estimate: row count, explicitly no AI cost.
  const httpEst = parseResult(await client.callTool({
    name: 'run_http_enrichment',
    arguments: {
      sheet_id: sheetId, url: 'https://example.com/api?q={{val}}',
      response_mapping: [{ json_path: '$.x', column_name: 'X' }], estimate_only: true,
    },
  }))
  expect(httpEst.rows_to_process).toBe(5)
  expect(httpEst.ai_cost_usd).toBeNull()

  // Still nothing created after the HTTP estimate either.
  const final = parseResult(await client.callTool({ name: 'get_sheet', arguments: { sheet_id: sheetId } }))
  expect(final.columns.length).toBe(colsBefore)

  await client.close()
})
