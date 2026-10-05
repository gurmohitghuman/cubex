import { test, expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { authedApi, seedSheet, BASE, makeAccessToken } from './helpers'

// Slice B: structured multi-column AI output.
// Part 1 (no OpenRouter key): validation + start-shape + column creation +
// classification — the run starts then fails fast per row, but the START path
// (parse, cap/collision, seed, column_order, return shape) is fully exercised.
// Part 2 (gated on CUBEX_SMOKE_OPENROUTER_KEY): the real round-trip — model
// returns JSON, we parse and write N typed columns + status ✅.

const SMOKE_KEY = process.env.CUBEX_SMOKE_OPENROUTER_KEY
// Cheapest model that reliably returns a clean JSON object; override with
// CUBEX_SMOKE_MODEL. Kept configurable so the live smoke can't silently bill a
// pricier model than the operator intended.
const SMOKE_MODEL = process.env.CUBEX_SMOKE_MODEL || 'deepseek/deepseek-v4-flash'


async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'e2e-multi', version: '1.0.0' })
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

const OUTPUT_COLUMNS = [
  { column_name: 'Fit Score', type: 'number', description: 'Integer 1-10 fit rating' },
  { column_name: 'Fit Reason', type: 'string', description: 'One short sentence why' },
]

test('multi-output: validation, start shape, and column creation', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 3)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e multi'))

  // web_search + output_columns is rejected.
  const combo: any = await client.callTool({
    name: 'run_ai_column',
    arguments: {
      sheet_id: sheetId, column_name: 'Lead', prompt: 'Rate /val',
      model: 'openai/gpt-4o-mini', web_search: true, output_columns: OUTPUT_COLUMNS,
    },
  })
  expect(combo.isError).toBeTruthy()

  // Collision: an output column named like an existing column is rejected.
  const collide: any = await client.callTool({
    name: 'run_ai_column',
    arguments: {
      sheet_id: sheetId, column_name: 'Lead', prompt: 'Rate /val',
      model: 'openai/gpt-4o-mini',
      output_columns: [{ column_name: 'val', type: 'string', description: 'dup' }],
    },
  })
  expect(collide.isError).toBeTruthy()

  // Valid start: returns status_column + output_columns and creates all three.
  const started = parseResult(await client.callTool({
    name: 'run_ai_column',
    arguments: {
      sheet_id: sheetId, column_name: 'Lead', prompt: 'Rate /val',
      model: 'openai/gpt-4o-mini', output_columns: OUTPUT_COLUMNS,
    },
  }))
  expect(started.run_id).toBeTruthy()
  expect(started.status_column).toBe('Lead (Status)')
  expect(started.output_columns).toEqual(['Fit Score', 'Fit Reason'])
  expect(started.target_rows).toBe(3)

  const sheet = parseResult(await client.callTool({ name: 'get_sheet', arguments: { sheet_id: sheetId } }))
  for (const c of ['Fit Score', 'Fit Reason', 'Lead (Status)']) expect(sheet.columns).toContain(c)

  await client.close()
})

test('multi-output: live round-trip writes typed columns', async () => {
  test.skip(!SMOKE_KEY, 'set CUBEX_SMOKE_OPENROUTER_KEY to run the live smoke')
  test.setTimeout(90_000)
  const api = await authedApi()
  // Give this user the OpenRouter key so runs actually execute.
  const put = await api.put('/api/settings/openrouter-key', { data: { apiKey: SMOKE_KEY } })
  expect(put.ok()).toBeTruthy()
  // The key lands on the SHARED seed user and would outlive this test — a later
  // spec asserting "no key configured" would then see one. Always clear it.
  const clearKey = async () => { await api.delete('/api/settings/openrouter-key') }

  const { sheetId } = await seedSheet(api, 2)
  // Real inputs the model can actually score (nonsense inputs correctly yield
  // null → blank cells, which isn't what we're testing here).
  await api.put(`/api/sheets/${sheetId}/data`, { data: { updates: [
    { rowIndex: 0, columnName: 'val', value: 'Stripe — online payment processing APIs for internet businesses' },
    { rowIndex: 1, columnName: 'val', value: 'Notion — all-in-one workspace for notes, docs, and collaboration' },
  ] } })
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e multi live'))

  const started = parseResult(await client.callTool({
    name: 'run_ai_column',
    arguments: {
      sheet_id: sheetId, column_name: 'Lead', model: SMOKE_MODEL,
      prompt: 'Score this company as a B2B SaaS lead: /val. Give a fit score 1-10 and a one-sentence reason.',
      output_columns: OUTPUT_COLUMNS,
    },
  }))
  const runId = started.run_id

  // Poll to terminal.
  let status: any = null
  for (let i = 0; i < 100; i++) {
    status = parseResult(await client.callTool({
      name: 'get_run_status', arguments: { run_type: 'ai', run_id: runId },
    }))
    if (['completed', 'failed', 'cancelled'].includes(status?.status)) break
    await new Promise(r => setTimeout(r, 1000))
  }
  expect(status.status).toBe('completed')

  // Both typed columns filled, status ✅, no leftover ⏳.
  const rows = parseResult(await client.callTool({ name: 'read_rows', arguments: { sheet_id: sheetId } }))
  for (const row of rows.rows) {
    expect(row.data['Lead (Status)']).toBe('✅')
    expect(String(row.data['Fit Score'])).toMatch(/^\d+(\.\d+)?$/)
    expect(String(row.data['Fit Reason']).length).toBeGreaterThan(0)
    expect(row.data['Fit Score']).not.toContain('⏳')
  }

  await client.close()
  await clearKey()
})
