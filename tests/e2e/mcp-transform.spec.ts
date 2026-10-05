import { test, expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { authedApi, seedSheet, BASE, makeAccessToken } from './helpers'

// Slice C: transform_column — non-AI server-side transforms. No OpenRouter key
// needed. Covers the headline case (extract a number from "N | reason"),
// template, where-filtering, target creation, collision + ReDoS rejection.

// transform_column is flag-gated at process start (same flag as transfer_rows);
// without it the tool is absent from discovery and every call errors, so skip
// rather than fail the default harness run.
test.skip(
  !['1', 'true'].includes((process.env.MCP_EFFICIENT_ROWS_ENABLED ?? '').toLowerCase()),
  'requires MCP_EFFICIENT_ROWS_ENABLED=1 in the harness env',
)



async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'e2e-transform', version: '1.0.0' })
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

test('transform_column: extract, template, where, collision, ReDoS', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 3)
  // Seed a "Raw" column shaped like an AI score+reason blob.
  await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: 'Raw' } })
  await api.put(`/api/sheets/${sheetId}/data`, { data: { updates: [
    { rowIndex: 0, columnName: 'Raw', value: '8 | B2B SaaS' },
    { rowIndex: 1, columnName: 'Raw', value: '3 | consumer app' },
    { rowIndex: 2, columnName: 'Raw', value: 'no score here' },
  ] } })
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e transform'))

  // regex_extract: "8 | reason" → 8 into a NEW column.
  const extracted = parseResult(await client.callTool({
    name: 'transform_column',
    arguments: {
      sheet_id: sheetId, source_column: 'Raw', target_column: 'Score',
      operation: 'regex_extract', pattern: '^(\\d+)',
    },
  }))
  expect(extracted.updated).toBe(3)
  expect(extracted.created_column).toBe('Score')

  let rows = parseResult(await client.callTool({ name: 'read_rows', arguments: { sheet_id: sheetId } })).rows
  expect(rows[0].data['Score']).toBe('8')
  expect(rows[1].data['Score']).toBe('3')
  expect(rows[2].data['Score']).toBe('') // no match → blank

  // The new Score column is numerically usable by where (Slice A numeric ops).
  const gte5 = parseResult(await client.callTool({
    name: 'read_rows', arguments: { sheet_id: sheetId, where: [{ column: 'Score', operator: 'gte', value: '5' }], return_mode: 'count' },
  }))
  expect(gte5.count).toBe(1)

  // template into a new column, only for rows where Score >= 5.
  const templated = parseResult(await client.callTool({
    name: 'transform_column',
    arguments: {
      sheet_id: sheetId, target_column: 'Label', operation: 'template',
      template: 'score={{Score}} raw={{Raw}}',
      where: [{ column: 'Score', operator: 'gte', value: '5' }],
    },
  }))
  expect(templated.updated).toBe(1)
  rows = parseResult(await client.callTool({ name: 'read_rows', arguments: { sheet_id: sheetId } })).rows
  expect(rows[0].data['Label']).toBe('score=8 raw=8 | B2B SaaS')
  expect(rows[1].data['Label']).toBe('') // filtered out → stays blank

  // Collision: target a case-variant of an existing column.
  const collide: any = await client.callTool({
    name: 'transform_column',
    arguments: { sheet_id: sheetId, source_column: 'Raw', target_column: 'raw', operation: 'upper' },
  })
  expect(collide.isError).toBeTruthy()

  // ReDoS: a nested-quantifier pattern is rejected, not run.
  const redos: any = await client.callTool({
    name: 'transform_column',
    arguments: { sheet_id: sheetId, source_column: 'Raw', target_column: 'Bad', operation: 'regex_extract', pattern: '(a+)+$' },
  })
  expect(redos.isError).toBeTruthy()

  await client.close()
})
