import { test, expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { authedApi, seedSheet, BASE, makeAccessToken } from './helpers'

// Slice D: idempotency_key (no key needed) + preview_rows (gated on the key).

const SMOKE_KEY = process.env.CUBEX_SMOKE_OPENROUTER_KEY
// Only the LIVE preview below bills real calls; override with CUBEX_SMOKE_MODEL.
const SMOKE_MODEL = process.env.CUBEX_SMOKE_MODEL || 'deepseek/deepseek-v4-flash'


async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'e2e-preview-idem', version: '1.0.0' })
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

test('idempotency_key: same key replays run_id; different args conflict', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e idem'))
  const base = { sheet_id: sheetId, column_name: 'Idem', prompt: 'echo /val', model: 'openai/gpt-4o-mini' }

  const first = parseResult(await client.callTool({ name: 'run_ai_column', arguments: { ...base, idempotency_key: 'k1' } }))
  expect(first.run_id).toBeTruthy()
  expect(first.replayed).toBeFalsy()

  // Same key + same args → the ORIGINAL run_id, marked replayed, no new run.
  const replay = parseResult(await client.callTool({ name: 'run_ai_column', arguments: { ...base, idempotency_key: 'k1' } }))
  expect(replay.run_id).toBe(first.run_id)
  expect(replay.replayed).toBe(true)

  // Same key + DIFFERENT args → conflict.
  const conflict: any = await client.callTool({
    name: 'run_ai_column', arguments: { ...base, prompt: 'different prompt /val', idempotency_key: 'k1' },
  })
  expect(conflict.isError).toBeTruthy()

  await client.close()
})

test('preview_rows: sample outputs + measured cost, nothing persisted', async () => {
  test.skip(!SMOKE_KEY, 'set CUBEX_SMOKE_OPENROUTER_KEY to run the live preview')
  test.setTimeout(90_000)
  const api = await authedApi()
  const put = await api.put('/api/settings/openrouter-key', { data: { apiKey: SMOKE_KEY } })
  expect(put.ok()).toBeTruthy()
  // The key lands on the SHARED seed user and would outlive this test — a later
  // spec asserting "no key configured" would then see one. Always clear it.
  const clearKey = async () => { await api.delete('/api/settings/openrouter-key') }
  const { sheetId } = await seedSheet(api, 3)
  await api.put(`/api/sheets/${sheetId}/data`, { data: { updates: [
    { rowIndex: 0, columnName: 'val', value: 'Stripe — payment APIs' },
    { rowIndex: 1, columnName: 'val', value: 'Notion — workspace app' },
  ] } })
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e preview'))

  const before = parseResult(await client.callTool({ name: 'get_sheet', arguments: { sheet_id: sheetId } }))

  const prev = parseResult(await client.callTool({
    name: 'run_ai_column',
    arguments: {
      sheet_id: sheetId, column_name: 'Pitch', model: SMOKE_MODEL,
      prompt: 'In 5 words, what does this company do: /val', preview_rows: 2,
    },
  }))
  expect(prev.sampled_rows).toBe(2)
  expect(prev.rows_in_full_run).toBe(3)
  expect(prev.preview.length).toBe(2)
  expect(prev.preview[0].output.length).toBeGreaterThan(0)
  if (prev.measured_cost_usd !== null) expect(prev.projected_full_run_usd).toBeGreaterThanOrEqual(prev.measured_cost_usd)

  // Nothing persisted: no "Pitch (Output)" column created.
  const after = parseResult(await client.callTool({ name: 'get_sheet', arguments: { sheet_id: sheetId } }))
  expect(after.columns.length).toBe(before.columns.length)
  expect(after.columns).not.toContain('Pitch (Output)')

  await client.close()
  await clearKey()
})
