// What the HTTP API start replay tests share (token-replay-*-http.test.ts): an account, /api/v1's run routes and
// the MCP server for a token with the 'secrets' scope and one without it, each start's answer in one shape, and
// the job queue only recording (no run is worked, nothing is sent). Not a test itself (no .test.ts).
import path from 'node:path'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import express from 'express'
import cookieParser from 'cookie-parser'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { undoKit } from './run-undo-kit'
import constMod from '../../server/src/lib/api-v1-constants'
import authMod from '../../server/src/lib/auth'
import tokenStartMod from '../../server/src/services/run-start-token-http'
import runsMod from '../../server/src/routes/api-v1-runs'
import keysMod from '../../server/src/routes/settings-api-keys'
import mcpMod from '../../server/src/mcp/build-server'
import timeoutsMod from '../../server/src/lib/server-timeouts'
const { MCP_RUN_STARTS_PER_MIN } = constMod as typeof import('../../server/src/lib/api-v1-constants')
const { signToken } = authMod as typeof import('../../server/src/lib/auth')
const { tokenStartHttpRun } = tokenStartMod as typeof import('../../server/src/services/run-start-token-http')
const { default: v1Runs } = runsMod as unknown as { default: express.Router }
const { default: keyRoutes } = keysMod as unknown as { default: express.Router }
const { buildMcpServer } = mcpMod as typeof import('../../server/src/mcp/build-server')
const { applyServerTimeouts } = timeoutsMod as typeof import('../../server/src/lib/server-timeouts')

export type Answer = { status?: number; ok?: Record<string, unknown>; fail?: string; message?: string }
export type Args = Record<string, unknown> & { sheet_id: string }
export const SURFACE_NAMES = ['service', 'rest', 'mcp'] as const
export type Surface = typeof SURFACE_NAMES[number]
export const CONFLICT = 'Idempotency key was already used with different arguments.'
// More retries than the token's run-start window holds: had one taken a slot, the next new start would be refused.
export const TRIES = MCP_RUN_STARTS_PER_MIN + 1
// Each case's own key (one saved with the same value would be used instead), built at runtime.
export const curlWith = (tag: string) => `curl 'https://api.example.com/find?n={{Name}}' -H 'Authorization: Bearer `
  + `${['sk', 'proj', `replay${tag}0123456789abcdefgh`].join('-')}'`

export async function httpKit(name: string) {
  const kit = undoKit(name)
  const { db, uid, sheet } = kit
  console.error = () => {}
  const { Sidequest } = createRequire(path.resolve('server/src/queue.ts'))('sidequest')
  Sidequest.build = () => ({ enqueue: async () => ({}) })
  // A run webhook's address must look public: the e2e shim resolves *.cubex-e2e.invalid so (nothing is sent).
  process.env.E2E_RECEIVER_PORT = '9'
  createRequire(import.meta.url)('../e2e/net-shim.cjs')

  const ALL = ['read', 'write', 'run', 'secrets'], RUN = ['read', 'write', 'run']
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  for (const [mount, tokenId, scopes] of [['/v1', 'tok-v1', ALL], ['/v1run', 'tok-v1-run', RUN]] as const) {
    app.use(mount, (req, _res, next) => {
      Object.assign(req, { userId: uid, accessTokenId: tokenId, tokenScopes: new Set(scopes) })
      next()
    }, v1Runs)
  }
  app.use('/api/settings', keyRoutes)
  const server = app.listen(0)
  applyServerTimeouts(server)
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const cookie = `cubex_session=${signToken({ userId: uid, sessionEpoch: 0 })}`
  const clients: Record<string, Client> = {}
  for (const [tokenId, scopes] of [['tok-mcp', ALL], ['tok-mcp-run', RUN]] as const) {
    const mcp = buildMcpServer({ userId: uid, tokenId, tokenName: 'n', scopes: new Set(scopes) as never })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await mcp.connect(serverSide)
    const client = new Client({ name: 'unit', version: '1.0.0' })
    await client.connect(clientSide)
    clients[tokenId] = client
  }

  // One start over a surface, by the token with 'secrets' or (secrets: false) the one without: what the service
  // answers, REST's status and body, MCP's parsed text (isError as a fail).
  async function start(surface: Surface, a: Args, opts: { secrets?: boolean } = {}): Promise<Answer> {
    const secrets = opts.secrets !== false
    if (surface === 'service') {
      const tokenId = secrets ? 'tok-service' : 'tok-service-run'
      const r = await tokenStartHttpRun({ userId: uid, tokenId, scopes: new Set(secrets ? ALL : RUN) }, a)
      return 'fail' in r ? { fail: r.fail, message: r.message } : { ok: { ...r.ok }, status: r.started ? 202 : 200 }
    }
    if (surface === 'rest') {
      const { sheet_id, ...body } = a
      const res = await fetch(`${base}/${secrets ? 'v1' : 'v1run'}/sheets/${sheet_id}/http-runs`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const json = await res.json() as Record<string, unknown>
      return res.ok ? { ok: json, status: res.status } : { status: res.status, message: json.error as string }
    }
    const res = await clients[secrets ? 'tok-mcp' : 'tok-mcp-run'].callTool({ name: 'run_http_enrichment',
      arguments: a }) as { content: Array<{ text: string }>; isError?: boolean }
    const json = JSON.parse(res.content[0].text) as Record<string, unknown>
    return res.isError ? { fail: 'error', message: json.error as string } : { ok: json }
  }
  // A refusal as each surface says it: the service's fail kind, REST's status, MCP's isError (in `mcp`'s words
  // when they differ: MCP adds a next step, mcp/next-steps.ts).
  const refusal = (surface: Surface, fail: string, status: number, message: string, mcp = message): Answer =>
    surface === 'service' ? { fail, message } : surface === 'rest' ? { status, message }
      : { fail: 'error', message: mcp }

  return {
    ...kit, start, refusal, base, cookie,
    fresh: () => sheet([{ Name: 'ada' }, { Name: 'bob' }], ['Name']),
    runsOn: (sid: string) => db.prepare('SELECT COUNT(*) FROM http_runs WHERE sheet_id = ?').pluck().get(sid),
    keyNames: () => db.prepare('SELECT name FROM api_keys WHERE user_id = ? ORDER BY name').pluck().all(uid),
    close: () => server.close(),
  }
}
