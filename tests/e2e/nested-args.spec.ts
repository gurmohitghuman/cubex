import { test, expect } from '@playwright/test'
import { BASE, authedApi, makeAccessToken, seedSheet } from './helpers'
import { mcpClient } from './helpers-mcp'

// An argument nested far deeper than any tool takes (about 3,000 levels in 10 KB, sent where a run start never
// looks, such as an AI run's temperature or an HTTP run's method) is refused with a 400 before anything reads it,
// over REST and MCP, instead of a 500 and a server log line; an ordinary nested body is still accepted.
const deep = (levels: number): unknown => {
  let v: unknown = 'x'
  for (let i = 0; i < levels; i++) v = [v]
  return v
}

test('a deeply nested argument is refused with a 400 over REST and MCP', async () => {
  const api = await authedApi()
  const token = await makeAccessToken(api, ['read', 'write', 'run'], `nested-${Date.now()}`)
  const auth = { Authorization: `Bearer ${token}` }
  const { sheetId } = await seedSheet(api, 2)
  const starts: Array<[string, Record<string, unknown>]> = [
    [`/api/v1/sheets/${sheetId}/ai-runs`, { prompt: 'Hi {{val}}', column_name: 'A', temperature: deep(3000) }],
    [`/api/v1/sheets/${sheetId}/http-runs`, { url: 'https://example.com', method: deep(3000), master_column_name: 'H' }],
    [`/api/v1/sheets/${sheetId}/enrichment-runs`, { tool_id: 'treg.people.email.find', column_name: 'E',
      inputs: deep(3000) }],
    [`/api/v1/sheets/${sheetId}/waterfall-columns`, { column: 'W', steps: deep(3000) }],
  ]
  for (const [path, data] of starts) {
    const res = await api.post(`${BASE}${path}`, { headers: auth, data })
    const text = await res.text()
    expect.soft(res.status(), `${path}: ${text.slice(0, 200)}`).toBe(400)
    expect.soft(text, path).toContain('levels deep')
  }

  // MCP: a JSON-RPC error for the request, before any tool reads it.
  const rpc = await api.post(`${BASE}/mcp`, { headers: { ...auth, Accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_ai_column',
      arguments: { sheet_id: sheetId, prompt: 'Hi', column_name: 'A', temperature: deep(3000) } } } })
  expect(rpc.status()).toBe(400)
  const body = await rpc.json()
  expect(body.error.code).toBe(-32600)
  expect(body.error.message).toContain('levels deep')
  // A tool call nested well within the limit still reaches the tool.
  const client = await mcpClient(token)
  const near: any = await client.callTool({ name: 'read_rows', arguments: { sheet_id: sheetId } })
  expect(near.isError).toBeFalsy()
  // An ordinary nested body (a where with a few levels) still works.
  const fine = await api.post(`${BASE}/api/v1/sheets/${sheetId}/rows/query`, { headers: auth,
    data: { where: [{ column: 'val', operator: 'not_empty' }] } })
  expect(fine.status()).toBe(200)
})
