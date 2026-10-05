import { test, expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { authedApi, seedSheet, BASE, makeAccessToken } from './helpers'

// Structured output together with web fetch (and search): ONE call per row fills
// the typed columns plus a "<name> (Data)" sources column. No OpenRouter key
// here, so rows fail fast; that still exercises the estimate (web fees), the
// start (the (Data) column is created and returned), the preview's clean error,
// and the failure write (nothing left on the placeholder).

const OUTPUT_COLUMNS = [
  { column_name: 'Keep', type: 'boolean', description: 'Worth contacting?' },
  { column_name: 'Reason', type: 'string', description: 'One short sentence' },
]

function parseResult(res: { content?: Array<{ type: string; text?: string }> }): any {
  const text = res.content?.find(c => c.type === 'text')?.text
  return text ? JSON.parse(text) : null
}

test('structured run with web_fetch: estimate, (Data) column, clean failures', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 3)
  const client = new Client({ name: 'e2e-web-structured', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${await makeAccessToken(api, ['read', 'write', 'run'], 'e2e web structured')}` } },
  }))
  const base = {
    sheet_id: sheetId, column_name: 'Screen', prompt: 'Screen the company at /val',
    model: 'openai/gpt-4o-mini', output_columns: OUTPUT_COLUMNS, web_fetch: true,
  }

  // The estimate prices the web fees and the fetched text, and creates nothing.
  const est = parseResult(await client.callTool({ name: 'run_ai_column', arguments: { ...base, estimate_only: true } }))
  expect(est.rows_to_process).toBe(3)
  expect(est.web_fees_usd.high).toBeGreaterThan(0)
  expect(est.assumptions.input_tokens.high).toBeGreaterThan(est.assumptions.avg_input_tokens)
  expect(est.note).toContain('fetch fees')
  const before = parseResult(await client.callTool({ name: 'get_sheet', arguments: { sheet_id: sheetId } }))
  expect(before.columns).not.toContain('Screen (Data)')

  // A preview with no key fails cleanly (a 400-style tool error, not a crash).
  const preview: any = await client.callTool({ name: 'run_ai_column', arguments: { ...base, preview_rows: 1 } })
  expect(preview.isError).toBeTruthy()
  expect(JSON.stringify(preview.content)).toContain('OpenRouter API key')

  // The start returns and creates the (Data) column next to the typed ones.
  const started = parseResult(await client.callTool({ name: 'run_ai_column', arguments: base }))
  expect(started.status_column).toBe('Screen (Status)')
  expect(started.data_column).toBe('Screen (Data)')
  const sheet = parseResult(await client.callTool({ name: 'get_sheet', arguments: { sheet_id: sheetId } }))
  for (const c of ['Keep', 'Reason', 'Screen (Status)', 'Screen (Data)']) expect(sheet.columns).toContain(c)

  // Every row fails (no key), and the failure clears (Data) with the outputs.
  let status: any = null
  for (let i = 0; i < 60; i++) {
    status = parseResult(await client.callTool({ name: 'get_run_status', arguments: { run_type: 'ai', run_id: started.run_id } }))
    if (['completed', 'failed', 'cancelled'].includes(status?.status)) break
    await new Promise(r => setTimeout(r, 500))
  }
  expect(['completed', 'failed']).toContain(status.status)
  // The status names every column the run fills, so an agent knows where to read.
  expect(status.column_name).toBe('Screen (Status)')
  expect(status.output_columns).toEqual(['Keep', 'Reason'])
  expect(status.data_column).toBe('Screen (Data)')
  const listed = parseResult(await client.callTool({ name: 'list_runs', arguments: { sheet_id: sheetId } }))
  const mine = listed.runs.find((r: any) => r.id === started.run_id)
  expect(mine.output_columns).toEqual(['Keep', 'Reason'])
  const rows = parseResult(await client.callTool({ name: 'read_rows', arguments: { sheet_id: sheetId } }))
  for (const row of rows.rows) {
    expect(JSON.stringify(row.data)).not.toContain('⏳')
    expect(row.data['Screen (Data)'] ?? '').toBe('')
  }
  await client.close()
})
