// /mcp's refusals through the era router (server/src/mcp/http-entry.ts), in
// process, against the 2026-07-28 schema: the request's id or none, never null,
// and no code from the legacy -32000 range.
//   - A JSON-RPC batch is refused in either era before anything in it runs.
//   - The SDK's own refusals are reshaped (asTheSpecSays): its 406 and 415 get
//     -32600 instead of -32000, and id: null goes.
//   - A throw below the router is logged redacted and answered -32603 with the
//     request's id.
//   - The server's onerror is set: a protocol-layer error is logged, redacted;
//     a client's stray message is not.
import assert from 'node:assert/strict'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { mcpHttpKit, META, headersFor } from './mcp-http-kit'
import entryMod from '../../server/src/mcp/http-entry'
import answersMod from '../../server/src/mcp/http-answers'
const { mcpEntry, authInfoFor, reportMcpError, serverFor } =
  entryMod as typeof import('../../server/src/mcp/http-entry')
const { asTheSpecSays, BATCH_REFUSED, INTERNAL_ERROR } =
  answersMod as typeof import('../../server/src/mcp/http-answers')

const { ctx, check, done, crash, post } = mcpHttpKit('mcp-http-refusals')
const SECRET = `cubex_pat_${'b'.repeat(64)}`
const refused = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message } })

// What console.error gets while fn runs.
async function logsOf(fn: () => Promise<unknown>): Promise<string[]> {
  const logged: string[] = []
  const real = console.error
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')) }
  try { await fn() } finally { console.error = real }
  return logged
}

async function main() {
  await check('a batch is refused in either era, an empty one too: 400 with -32600, no id', async () => {
    const legacy = [{ jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_tables', arguments: {} } }]
    const modern = legacy.map(m => ({ ...m, params: { ...m.params, _meta: META } }))
    for (const [batch, headers] of [[legacy, {}], [modern, headersFor('tools/list')], [[], {}]] as const) {
      const res = await post(batch, headers)
      assert.deepEqual([res.status, res.type, JSON.parse(res.text)],
        [400, 'application/json', refused(-32600, BATCH_REFUSED)])
    }
  })

  await check('a batch in a body the caller did not parse is refused too', async () => {
    const request = new Request('http://127.0.0.1/mcp', { method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]) })
    const res = await mcpEntry.fetch(request, { authInfo: authInfoFor(ctx as never) })
    assert.deepEqual([res.status, await res.json()], [400, refused(-32600, BATCH_REFUSED)])
  })

  await check('the SDK\'s 406 and 415 get -32600 instead of -32000, and no id', async () => {
    const ping = { jsonrpc: '2.0', id: 3, method: 'ping' }
    const notAcceptable = await post(ping, { accept: 'application/json' })
    assert.deepEqual([notAcceptable.status, JSON.parse(notAcceptable.text)], [406,
      refused(-32600, 'Not Acceptable: Client must accept both application/json and text/event-stream')])
    for (const [body, headers] of [[ping, {}], [{ ...ping, params: { _meta: META } }, headersFor('ping')]] as const) {
      const request = new Request('http://127.0.0.1/mcp', { method: 'POST', body: JSON.stringify(body),
        headers: { 'content-type': 'text/plain', accept: 'application/json, text/event-stream', ...headers } })
      const res = await mcpEntry.fetch(request, { authInfo: authInfoFor(ctx as never) })
      assert.deepEqual([res.status, await res.json()],
        [415, refused(-32600, 'Unsupported Media Type: Content-Type must be application/json')])
    }
  })

  await check('asTheSpecSays: legacy codes by status, id: null dropped; a real id and a 2xx untouched', async () => {
    const answer = async (status: number, body: unknown, type = 'application/json') => {
      const res = await asTheSpecSays(new Response(JSON.stringify(body), { status, headers: { 'content-type': type } }))
      return [res.status, await res.json()]
    }
    const err = (code: number, id?: unknown) =>
      ({ jsonrpc: '2.0', error: { code, message: 'm' }, ...(id !== undefined && { id }) })
    assert.deepEqual(await answer(404, err(-32001, null)), [404, err(-32600)])
    const internal = { jsonrpc: '2.0', id: 5, error: { code: -32603, message: INTERNAL_ERROR } }
    assert.deepEqual(await answer(500, err(-32000, 5)), [500, internal])
    assert.deepEqual(await answer(500, { ...err(-32603, null), id: 5 }), [500, internal])
    assert.deepEqual(await answer(400, err(-32019, 4)), [400, err(-32600, 4)])
    assert.deepEqual(await answer(400, err(-32020, null)), [400, err(-32020)])
    assert.deepEqual(await answer(400, err(-32700, 'a')), [400, err(-32700, 'a')])
    assert.deepEqual(await answer(200, err(-32000, null)), [200, err(-32000, null)])
    assert.deepEqual(await answer(500, err(-32000, null), 'text/plain'), [500, err(-32000, null)])
  })

  await check('a throw below the router: logged, 500 with -32603 and the request id', async () => {
    let res = { status: 0, text: '' }
    // Without a caller the server can't be built: the route always sets one.
    const logged = await logsOf(async () => {
      res = await post({ jsonrpc: '2.0', id: 'x-1', method: 'tools/list', params: { cursor: SECRET } }, {}, false)
    })
    assert.deepEqual([res.status, JSON.parse(res.text)],
      [500, { jsonrpc: '2.0', id: 'x-1', error: { code: -32603, message: INTERNAL_ERROR } }])
    assert.equal(logged.length, 1)
    assert.match(logged[0], /^MCP request error: Error: MCP request without a signed-in token/)
    assert.ok(!logged[0].includes(SECRET))
  })

  await check('a protocol-layer error is logged once, redacted', async () => {
    const server = serverFor(authInfoFor(ctx as never))
    server.server.setNotificationHandler('notifications/roots/list_changed', () => {
      throw new Error(`could not refresh roots for Bearer ${SECRET}`)
    })
    const [client, side] = InMemoryTransport.createLinkedPair()
    await server.connect(side)
    const logged = await logsOf(async () => {
      await client.send({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' })
      await new Promise(resolve => setTimeout(resolve, 50))
    })
    await server.close()
    assert.equal(logged.length, 1, logged.join('\n'))
    assert.match(logged[0], /^MCP request error: Error: Uncaught error in notification handler: .*\[REDACTED\]/)
    assert.ok(!logged[0].includes(SECRET))
  })

  await check('a stray response or progress note from a client is not logged', async () => {
    const logged = await logsOf(async () => {
      for (const stray of [{ jsonrpc: '2.0', id: 99, result: { note: SECRET } },
        { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'p', progress: 1 } }]) {
        assert.deepEqual([(await post(stray)).status], [202])
      }
    })
    assert.deepEqual(logged, [])
  })

  await check('reportMcpError: the 2025-era transport\'s refusals are quiet, an internal failure logged', async () => {
    const logged = await logsOf(async () => {
      for (const words of ['Not Acceptable: Client must accept both',
        'Payload Too Large: Request body must not exceed 1', 'Bad Request: Server not initialized',
        'Invalid Request: Server already initialized',
        'Parse error: Invalid JSON', 'Received a response for an unknown message ID: {}']) {
        reportMcpError(new Error(words))
      }
      reportMcpError(new Error(`Failed to send response: socket closed after Bearer ${SECRET}`))
    })
    assert.equal(logged.length, 1)
    assert.match(logged[0], /^MCP request error: Error: Failed to send response: socket closed after \[REDACTED\]/)
  })

  done()
}

main().catch(crash)
