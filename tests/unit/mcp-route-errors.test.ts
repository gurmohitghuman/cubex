// /mcp's own refusals through the real router (server/src/routes/mcp.ts), in
// process, signed in with a real token. Each follows the 2026-07-28 schema: no
// id: null (the request's id, or none), no code from the legacy -32000 range,
// and words that say what to send instead. Bad JSON and a body over 2 MB get
// -32700; a POST that isn't JSON, or is JSON in a charset that isn't a UTF one or
// an encoding other than gzip or deflate, gets 415; GET and DELETE get 405 with
// Allow: POST; a batch gets -32600. A throw in the POST handler is logged
// redacted and answered -32603 with the request's id.
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { deflateSync, gzipSync } from 'node:zlib'
import express from 'express'
import { v4 as uuid } from 'uuid'
import { mcpHttpKit, META, headersFor } from './mcp-http-kit'
import dbMod from '../../server/src/lib/db'
import tokenMod from '../../server/src/lib/access-token'
import routeMod from '../../server/src/routes/mcp'
import answersMod from '../../server/src/mcp/http-answers'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { sha256Hex } = tokenMod as typeof import('../../server/src/lib/access-token')
const router = (routeMod as unknown as { default: express.Router }).default
const {
  BATCH_REFUSED, FORBIDDEN_ORIGIN, INTERNAL_ERROR, METHOD_NOT_ALLOWED, NOT_JSON, NOT_UTF8_JSON, PARSE_ERROR, TOO_LARGE,
} = answersMod as typeof import('../../server/src/mcp/http-answers')

const { ctx, check, done, crash } = mcpHttpKit('mcp-route-errors')
const TOKEN = `cubex_pat_${'7'.repeat(64)}`
db.prepare(`INSERT INTO access_tokens (id, user_id, name, token_hash, token_prefix, scopes) VALUES (?,?,?,?,?,?)`)
  .run(uuid(), ctx.userId, 'unit', sha256Hex(TOKEN), 'cubex_pat_7', 'read')

const refused = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message } })

async function main() {
  const app = express()
  // The Content-Type each request reached the router with, as sent.
  const contentTypes: Array<string | undefined> = []
  app.use('/mcp', (req, _res, next) => { contentTypes.push(req.headers['content-type']); next() }, router)
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
  const send = async (method: string, body?: string | Uint8Array, headers: Record<string, string> = {}) => {
    const res = await fetch(url, { method, body, headers: { authorization: `Bearer ${TOKEN}`,
      accept: 'application/json, text/event-stream', ...headers } })
    return { status: res.status, allow: res.headers.get('allow'), body: await res.json() }
  }
  const json = { 'content-type': 'application/json' }

  await check('bad JSON: 400 with -32700, no id', async () => {
    assert.deepEqual(await send('POST', '{"jsonrpc": "2.0", "id": 1,', json),
      { status: 400, allow: null, body: refused(-32700, PARSE_ERROR) })
  })

  await check('a body over 2 MB: 413 with -32700, no id', async () => {
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(2.1e6) } })
    assert.deepEqual(await send('POST', big, json), { status: 413, allow: null, body: refused(-32700, TOO_LARGE) })
  })

  // Sent as bytes: fetch gives a string body text/plain;charset=UTF-8 of its own.
  const ping = new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }))

  await check('a POST that is not JSON: 415 with -32600, no id', async () => {
    contentTypes.length = 0
    for (const headers of [{ 'content-type': 'text/plain' }, {}]) {
      assert.deepEqual(await send('POST', ping, headers),
        { status: 415, allow: null, body: refused(-32600, NOT_JSON) })
    }
    assert.deepEqual(contentTypes, ['text/plain', undefined])
  })

  await check('valid JSON in a non-UTF charset, or an encoding not undone: 415 with -32600', async () => {
    // An encoding refused names the ones Cubex reads (Accept-Encoding, RFC 9110 15.5.16).
    const cases = [[{ 'content-type': 'application/json; charset=latin1' }, null],
      [{ ...json, 'content-encoding': 'br' }, 'gzip, deflate'],
      [{ ...json, 'content-encoding': 'compress' }, 'gzip, deflate']] as const
    for (const [headers, acceptEncoding] of cases) {
      const res = await fetch(url, { method: 'POST', body: ping,
        headers: { authorization: `Bearer ${TOKEN}`, ...headers } })
      const got = { status: res.status, acceptEncoding: res.headers.get('accept-encoding'), body: await res.json() }
      assert.deepEqual(got, { status: 415, acceptEncoding, body: refused(-32600, NOT_UTF8_JSON) },
        JSON.stringify(headers))
    }
    // What the refusal asks for is answered: UTF-8, plain or with gzip or deflate.
    const sent = [[ping, {}], [ping, { 'content-type': 'application/json; charset=utf-8' }],
      [gzipSync(ping), { 'content-encoding': 'gzip' }], [deflateSync(ping), { 'content-encoding': 'deflate' }]] as const
    for (const [body, headers] of sent) {
      assert.deepEqual(await send('POST', body, { ...json, ...headers }),
        { status: 200, allow: null, body: { jsonrpc: '2.0', id: 1, result: {} } }, JSON.stringify(headers))
    }
  })

  await check('GET and DELETE: 405 with Allow: POST and -32600, no id', async () => {
    for (const method of ['GET', 'DELETE']) {
      assert.deepEqual(await send(method), { status: 405, allow: 'POST', body: refused(-32600, METHOD_NOT_ALLOWED) })
    }
  })

  await check('a batch, in either era: 400 with -32600, no id', async () => {
    const legacy = [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { jsonrpc: '2.0', id: 2, method: 'ping' }]
    const modern = legacy.map(m => ({ ...m, params: { _meta: META } }))
    for (const [batch, headers] of [[legacy, json], [modern, { ...json, ...headersFor('tools/list') }]] as const) {
      assert.deepEqual(await send('POST', JSON.stringify(batch), headers),
        { status: 400, allow: null, body: refused(-32600, BATCH_REFUSED) })
    }
  })

  await check('a page on another site: 403, no id', async () => {
    assert.deepEqual(await send('POST', '{}', { ...json, origin: 'http://elsewhere.example' }),
      { status: 403, allow: null, body: refused(-31403, FORBIDDEN_ORIGIN) })
  })

  await check('a throw in the POST handler: logged redacted, -32603 with the request id (none for a note)',
    async () => {
    type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> } }
    const layer = (router as unknown as { stack: Layer[] }).stack
      .find(l => l.route?.path === '/' && l.route.methods.post)
    const handle = layer!.route!.stack[0].handle
    const secret = `cubex_pat_${'a'.repeat(64)}`
    const logged: unknown[][] = []
    const real = console.error
    console.error = (...args: unknown[]) => { logged.push(args) }
    const answers: Array<[number, unknown]> = []
    try {
      for (const body of [{ jsonrpc: '2.0', id: 7, method: 'tools/list' }, { jsonrpc: '2.0', method: 'ping' }]) {
        const req = { headers: json, body, userId: ctx.userId, accessTokenId: 'tok', tokenScopes: ctx.scopes,
          get accessTokenName(): string { throw new Error(`token name lookup failed for Bearer ${secret}`) } }
        const res = { headersSent: false, statusCode: 0, sent: undefined as unknown, on() { return this },
          status(code: number) { this.statusCode = code; return this },
          json(sent: unknown) { this.sent = sent; answers.push([this.statusCode, sent]); return this } }
        await handle(req, res)
      }
    } finally { console.error = real }
    assert.deepEqual(logged.map(args => args[0]), ['MCP request error:', 'MCP request error:'])
    for (const args of logged) {
      const text = String(args[1])
      assert.ok(!text.includes(secret), text)
      assert.match(text, /token name lookup failed for \[REDACTED\]/)
    }
    assert.deepEqual(answers, [[500, { jsonrpc: '2.0', id: 7, error: { code: -32603, message: INTERNAL_ERROR } }],
      [500, refused(-32603, INTERNAL_ERROR)]])
  })

  server.close()
  done()
}

main().catch(crash)
