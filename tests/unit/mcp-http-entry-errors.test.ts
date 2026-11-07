// /mcp's refusals through the era router (server/src/mcp/http-entry.ts), in
// process. A version Cubex doesn't speak gets -32022 naming every version it
// does, newest first, and the v2 client still lands on 2026-07-28 from it. A
// tools/list cursor is refused with -32602 in both eras (Cubex hands none out);
// so is an unknown tool. The 2026 header without _meta is a 400 with -32602. A
// 2025-era batch gets one JSON array of answers. reportMcpError stays quiet for
// the codes a client causes and logs the rest (an internal -32603 included).
import assert from 'node:assert/strict'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { ProtocolError } from '@modelcontextprotocol/server'
import { mcpHttpKit, MODERN, META, headersFor } from './mcp-http-kit'
import entryMod from '../../server/src/mcp/http-entry'
import cursorMod from '../../server/src/mcp/list-cursor'
const { mcpEntry, authInfoFor, reportMcpError } = entryMod as typeof import('../../server/src/mcp/http-entry')
const { INVALID_CURSOR } = cursorMod as typeof import('../../server/src/mcp/list-cursor')

const { ctx, check, done, crash, post, modern, legacy } = mcpHttpKit('mcp-http-entry-errors')
const EVERY = [MODERN, '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']
const refusal = (id: number, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } })

async function main() {
  await check('-32022 names every version Cubex speaks, newest first; status and the rest as the SDK wrote them',
    async () => {
      const body = { jsonrpc: '2.0', id: 51, method: 'tools/list',
        params: { _meta: { ...META, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } } }
      const res = await post(body, headersFor('tools/list', undefined, '2099-01-01'))
      assert.deepEqual([res.status, res.type, JSON.parse(res.text)], [400, 'application/json', { jsonrpc: '2.0',
        error: { code: -32022, message: 'Unsupported protocol version: 2099-01-01',
          data: { supported: EVERY, requested: '2099-01-01' } }, id: 51 }])
    })

  await check('the v2 client offering a newer version first gets -32022, then lands on 2026-07-28', async () => {
    const seen: Array<[string | null, number, unknown]> = []
    const client = new Client({ name: 'unit', version: '1' },
      { supportedProtocolVersions: ['2099-01-01', MODERN, '2025-11-25'], versionNegotiation: { mode: 'auto' } })
    await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1/mcp'), {
      fetch: async (url, init) => {
        const request = new Request(url, init)
        const res = await mcpEntry.fetch(request.clone(), { authInfo: authInfoFor(ctx) })
        const answer = JSON.parse(await res.clone().text())
        seen.push([request.headers.get('mcp-protocol-version'), res.status, answer.error?.data?.supported])
        return res
      },
    }))
    assert.deepEqual(seen, [['2099-01-01', 400, EVERY], [MODERN, 200, undefined]])
    assert.deepEqual([client.getProtocolEra(), client.getNegotiatedProtocolVersion()], ['modern', MODERN])
    await client.close()
  })

  await check('a tools/list cursor is refused with -32602 in both eras, an empty one too', async () => {
    for (const cursor of ['abc', '']) {
      for (const res of [await modern('tools/list', { cursor }), await legacy('tools/list', { cursor })]) {
        assert.deepEqual([res.status, JSON.parse(res.text)], [200, refusal(res.id, -32602, INVALID_CURSOR)])
      }
    }
  })

  await check('an unknown tool is a JSON-RPC -32602 in both eras', async () => {
    const args = { name: 'nope', arguments: {} }
    for (const res of [await modern('tools/call', args, 'nope'), await legacy('tools/call', args)]) {
      assert.deepEqual([res.status, JSON.parse(res.text)], [200, refusal(res.id, -32602, 'Tool nope not found')])
    }
  })

  await check('the 2026-07-28 header on a request without _meta: 400 with -32602', async () => {
    const res = await post({ jsonrpc: '2.0', id: 52, method: 'tools/list', params: {} }, headersFor('tools/list'))
    assert.deepEqual([res.status, JSON.parse(res.text)], [400, { jsonrpc: '2.0', error: { code: -32602,
      message: 'Invalid params: the MCP-Protocol-Version header names protocol revision 2026-07-28, but the '
        + 'request is missing the required per-request envelope key(s): _meta',
      data: { envelope: { missing: ['_meta'] } } }, id: 52 }])
  })

  await check('a 2025-era batch gets one JSON array with an answer for each request, in order', async () => {
    const res = await post([{ jsonrpc: '2.0', id: 53, method: 'tools/list' },
      { jsonrpc: '2.0', id: 54, method: 'tools/call', params: { name: 'nope', arguments: {} } }])
    assert.deepEqual([res.status, res.type], [200, 'application/json'])
    const [listed, unknown] = JSON.parse(res.text)
    assert.deepEqual([listed.id, Object.keys(listed.result), listed.result.tools[0].name],
      [53, ['tools'], 'list_tables'])
    assert.deepEqual(unknown, refusal(54, -32602, 'Tool nope not found'))
  })

  await check('reportMcpError: quiet for the codes a client causes, logs the rest', () => {
    const logged: unknown[][] = []
    const real = console.error
    console.error = (...args: unknown[]) => { logged.push(args) }
    try {
      for (const code of [-32020, -32021, -32022, -32600, -32602, -32700]) {
        reportMcpError(new ProtocolError(code, `refused ${code}`))
      }
      reportMcpError(new Error('Rejected inbound request (headers): Mcp-Name missing'))
      reportMcpError(new Error('Unsupported Media Type: Content-Type must be application/json'))
      assert.equal(logged.length, 0)
      reportMcpError(new ProtocolError(-32603, 'Internal error'))
      reportMcpError(new ProtocolError(-32601, 'Method not found'))
      reportMcpError(new Error('factory blew up'))
      assert.deepEqual(logged.map(args => args[0]), ['MCP request error:', 'MCP request error:', 'MCP request error:'])
    } finally { console.error = real }
  })

  done()
}

main().catch(crash)
