// The column trash as a token reaches it, for its unit tests: the /api/v1 column and trash routes (an express
// app standing in for the token check, with the token's scopes) and the MCP tools (an in-memory client); and
// the app's own column delete (/api/sheets, signed in with a session cookie).
import express from 'express'
import cookieParser from 'cookie-parser'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import columnsMod from '../../server/src/routes/api-v1-columns'
import trashMod from '../../server/src/routes/api-v1-trash'
import mcpMod from '../../server/src/mcp/build-server'
import scopesMod from '../../server/src/lib/access-token'
import appDeleteMod from '../../server/src/routes/sheets-columns-delete'
import authMod from '../../server/src/lib/auth'
import timeoutsMod from '../../server/src/lib/server-timeouts'
const { default: columnsRouter } = columnsMod as unknown as { default: express.Router }
const { default: trashRouter } = trashMod as unknown as { default: express.Router }
const { buildMcpServer } = mcpMod as typeof import('../../server/src/mcp/build-server')
const { expandScopes } = scopesMod as typeof import('../../server/src/lib/access-token')
const { default: appDeleteRouter } = appDeleteMod as unknown as { default: express.Router }
const { signToken } = authMod as typeof import('../../server/src/lib/auth')
const { applyServerTimeouts } = timeoutsMod as typeof import('../../server/src/lib/server-timeouts')

export interface Answer { status: number; body: any }

// `scopes` as a token stores them ("read,write,run"): write and run include read, as for a real token.
export async function trashSurfaces(uid: string, scopes: string) {
  const granted = expandScopes(scopes)
  const web = express()
  web.use(cookieParser())
  web.use(express.json())
  web.use('/api/sheets', appDeleteRouter)
  web.use('/v1', (req, _res, next) => {
    Object.assign(req, { userId: uid, accessTokenId: 'tok-rest', accessTokenName: 'unit', tokenScopes: granted })
    next()
  }, columnsRouter, trashRouter)
  // With the real server's timeouts: a test that holds the event loop for seconds between two requests on one
  // kept-alive connection would otherwise see it closed under Node's 5-second default.
  const server = web.listen(0)
  applyServerTimeouts(server)
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const ask = async (url: string, method: string, body: unknown, cookie?: string): Promise<Answer> => {
    let r: Response
    try {
      r = await fetch(url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body) })
    } catch (err) {
      // "fetch failed" alone doesn't say why: the cause does (ECONNRESET, a timeout, a refused connection).
      const cause = (err as { cause?: { code?: string; message?: string } }).cause
      throw new Error(`${method} ${url}: ${(err as Error).message} (${cause?.code ?? 'no code'}: `
        + `${cause?.message ?? 'no cause'})`, { cause: err })
    }
    return { status: r.status, body: await r.json() }
  }
  const rest = (method: string, path: string, body?: unknown) => ask(`${origin}/v1${path}`, method, body)
  const session = `cubex_session=${signToken({ userId: uid, sessionEpoch: 0 })}`
  // The app's own route, as the grid's column menu calls it.
  const app = (method: string, path: string) => ask(`${origin}/api${path}`, method, undefined, session)
  const mcp = buildMcpServer({ userId: uid, tokenId: 'tok-mcp', tokenName: 'unit', scopes: granted })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await mcp.connect(serverSide)
  const client = new Client({ name: 'unit', version: '1.0.0' })
  await client.connect(clientSide)
  // A tool's answer: isError, and its JSON.
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: any[] }
    return { isError: !!res.isError, body: JSON.parse(res.content[0].text) }
  }
  const close = async () => { await client.close(); server.close() }
  return { rest, call, app, close }
}
