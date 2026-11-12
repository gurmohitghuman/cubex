import { test, expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import Database from 'better-sqlite3'
import crypto from 'node:crypto'
import { authedApi, seedSheet, BASE, makeAccessToken, assertTestDb } from './helpers'

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

// A finished run of this column in the throwaway DB, as a start stores it: 6 rows of 42 output tokens, paid
// with the user's own provider key (migration 055).
function seedColumnRun(sheetId: string, column: string, model: string) {
  const db = new Database(assertTestDb(process.env.DB_PATH))
  try {
    db.pragma('busy_timeout = 5000')
    const user = db.prepare('SELECT id FROM users LIMIT 1').pluck().get() as string
    const runId = crypto.randomUUID()
    db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, status, created_at)
      VALUES (?, ?, ?, ?, 'Earlier words /val', ?, 'completed', datetime('now', '+1 minute'))`)
      .run(runId, sheetId, user, column, model)
    for (let i = 0; i < 6; i++) {
      db.prepare(`INSERT INTO ai_results (id, run_id, user_id, row_index, output_value, status, prompt_tokens,
        completion_tokens, cost_usd, paid_with) VALUES (?, ?, ?, ?, 'x', 'completed', 20, 42, 0, 'own_key')`)
        .run(crypto.randomUUID(), runId, user, i)
    }
  } finally { db.close() }
}

test('estimate_only: history from this column, in_flight on the own key, fetch limits refused alike', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 5)
  const token = await makeAccessToken(api, ['read', 'write', 'run'], 'e2e estimate history')
  const client = await mcpClient(token)
  const model = 'openai/gpt-4o-mini'
  seedColumnRun(sheetId, 'Summary (Output)', model)
  const args = { sheet_id: sheetId, column_name: 'Summary', prompt: 'Summarize /val', model, estimate_only: true,
    concurrency: 7 }

  const est = parseResult(await client.callTool({ name: 'run_ai_column', arguments: args }))
  expect(est.assumptions.history_from).toBe('column')
  expect(est.assumptions.history_rows).toBe(6)
  expect(est.assumptions.output_tokens).toEqual({ low: 42, high: 42 })
  expect(est.basis).toBe('history')
  expect(est.own_provider_key).toBe(true)
  // Only when OpenRouter's public catalog priced the model: the own key no longer hides in_flight.
  if (est.pricing_available) {
    expect(est.in_flight.concurrency).toBe(7)
    expect(est.in_flight.note).toContain('OpenRouter can hold in-flight budget on an own-key run too')
  }
  // Another column: no history of its own, so the model's runs (this one among them) answer.
  const other = parseResult(await client.callTool({ name: 'run_ai_column', arguments: { ...args,
    column_name: 'Elsewhere' } }))
  expect(other.assumptions.history_from).toBe('model')

  // The same answer over REST, and the fetch limits refused with the same words on both surfaces.
  const rest = (body: Record<string, unknown>) => api.post(`${BASE}/api/v1/sheets/${sheetId}/ai-runs`,
    { headers: { Authorization: `Bearer ${token}` }, data: body })
  const viaRest = await rest({ ...args, sheet_id: undefined })
  expect(viaRest.status()).toBe(200)
  expect((await viaRest.json()).assumptions.history_from).toBe('column')
  const range = 'max_pages_per_row must be a whole number from 1 to 50.'
  const mcpRange = await client.callTool({ name: 'run_ai_column', arguments: { ...args, web_fetch: true,
    max_pages_per_row: 51 } }) as { isError?: boolean; content: Array<{ text: string }> }
  expect(mcpRange.isError).toBe(true)
  expect(mcpRange.content[0].text)
    .toBe(`Input validation error: Invalid arguments for tool run_ai_column: max_pages_per_row: ${range}`)
  const restRange = await rest({ ...args, web_fetch: true, max_pages_per_row: 51 })
  expect(restRange.status()).toBe(400)
  expect((await restRange.json()).error).toBe(range)
  const needs = 'max_content_tokens and max_pages_per_row need web_fetch turned on.'
  const mcpNeeds = await client.callTool({ name: 'run_ai_column', arguments: { ...args, max_content_tokens: 500 } })
  expect(mcpNeeds.isError).toBe(true)
  expect(parseResult(mcpNeeds as any).error).toBe(needs)
  expect((await (await rest({ ...args, max_content_tokens: 500 })).json()).error).toBe(needs)
  // Digits sent as text are taken by both.
  const digits = { ...args, web_fetch: true, max_content_tokens: '800', max_pages_per_row: '2' }
  expect(parseResult(await client.callTool({ name: 'run_ai_column', arguments: digits })).rows_to_process).toBe(5)
  expect((await rest(digits)).status()).toBe(200)
  await client.close()
})
