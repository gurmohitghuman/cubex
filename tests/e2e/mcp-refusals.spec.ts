import { test, expect } from '@playwright/test'
import { authedApi, BASE, makeAccessToken, seedSheet } from './helpers'

// /mcp's refusals over the real endpoint, in either protocol era, as the
// 2026-07-28 schema has them: the request's id or none (never id: null), no
// code from the legacy -32000 range, and words that say what to send instead.
// A batch runs nothing. 2026-07-28 headers and errors: mcp-protocol.spec.ts.

const MODERN = '2026-07-28'
const META = { 'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientInfo': { name: 'e2e-refusals', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {} }
const MODERN_HEADERS = { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/list' }
const refused = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message } })
const BATCH = 'Invalid Request: JSON-RPC batches are not supported. Send one request per POST.'
const CURSOR = 'Invalid cursor: tools/list answers every tool at once and gives no cursor. Send tools/list without one.'

test('MCP refusals: a batch, a body that is not JSON, the media type and a null cursor', async () => {
  const api = await authedApi()
  const token = await makeAccessToken(api, ['read', 'write'], 'e2e mcp refusals')
  const post = async (body: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${BASE}/mcp`, { method: 'POST', body, headers: { Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers } })
    return { status: res.status, body: await res.json() }
  }

  // A batch, 2025-era or with the 2026-07-28 envelope, is refused whole: its add_column never runs.
  const { sheetId } = await seedSheet(api, 1)
  const add = { jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'add_column', arguments: { sheet_id: sheetId, name: 'Batched' } } }
  const legacy = [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, add]
  const modern = legacy.map(m => ({ ...m, params: { ...m.params, _meta: META } }))
  for (const [batch, headers] of [[legacy, {}], [modern, MODERN_HEADERS], [[], {}]] as const) {
    expect(await post(JSON.stringify(batch), headers)).toEqual({ status: 400, body: refused(-32600, BATCH) })
  }
  const sheet = await fetch(`${BASE}/api/v1/sheets/${sheetId}`, { headers: { Authorization: `Bearer ${token}` } })
  expect(sheet.status).toBe(200)
  expect(await sheet.text()).not.toContain('Batched')

  // A body that isn't JSON, or is over 2 MB: Parse error (-32700), no id.
  expect(await post('{"jsonrpc": "2.0", "id": 1,')).toEqual({ status: 400,
    body: refused(-32700, 'Parse error: the body is not valid JSON. Send one JSON-RPC request as JSON.') })
  const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(2_100_000) } })
  expect(await post(big)).toEqual({ status: 413,
    body: refused(-32700, 'Request body too large: send at most 2 MB per request.') })

  // A POST that isn't JSON: 415 with Invalid Request (-32600), no id; not -32000 with id: null.
  expect(await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), { 'Content-Type': 'text/plain' }))
    .toEqual({ status: 415, body: refused(-32600,
      'Unsupported Media Type: send the request as JSON, with Content-Type: application/json.') })

  // "cursor": null is a cursor Cubex never gave: -32602 with the request's id, in both eras.
  const nullCursor = [
    post(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: { cursor: null } })),
    post(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: { cursor: null, _meta: META } }),
      MODERN_HEADERS),
  ]
  for (const res of await Promise.all(nullCursor)) {
    expect(res).toEqual({ status: 200, body: { jsonrpc: '2.0', id: 7, error: { code: -32602, message: CURSOR } } })
  }
})
