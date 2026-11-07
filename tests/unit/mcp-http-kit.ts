// Shared fixture for /mcp's router tests (mcp-http-entry, mcp-http-entry-errors):
// a migrated throwaway database, one account, a read-only caller with a spend
// cap, and POSTs through mcpEntry as routes/mcp.ts hands them on (parsed body,
// caller in authInfo). A run that stops before done() fails: an answer stream
// that never ends leaves nothing for Node to wait on, and it would exit 0.
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import entryMod from '../../server/src/mcp/http-entry'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { mcpEntry, authInfoFor } = entryMod as typeof import('../../server/src/mcp/http-entry')

export const MODERN = '2026-07-28'
export const SERVER = { 'io.modelcontextprotocol/serverInfo': { name: 'cubex', version: '1.0.0' } }
export const META = { 'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientInfo': { name: 'unit', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {} }
// The three request headers a 2026-07-28 POST carries.
export const headersFor = (method: string, name?: string, version = MODERN): Record<string, string> =>
  ({ 'mcp-protocol-version': version, 'mcp-method': method, ...(name ? { 'mcp-name': name } : {}) })

export function mcpHttpKit(name: string) {
  if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
  runMigrations()
  const uid = uuid()
  db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
  const spend = { spend_cap_usd: 5, spent_usd: 1, left_usd: 4 }
  const ctx = { userId: uid, tokenId: 'tok', tokenName: 'unit', scopes: new Set(['read'] as const), spend }

  let failures = 0, finished = false
  process.on('exit', () => {
    if (!finished) { console.log('FAIL the run stopped before its end'); process.exitCode = 1 }
  })
  const check = async (label: string, fn: () => void | Promise<void>) => {
    try { await fn(); console.log('ok  ', label) }
    catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
  }
  const done = () => {
    finished = true
    if (failures) { console.error(`${failures} ${name} check(s) failed`); process.exit(1) }
    console.log(`All ${name} assertions passed.`)
    process.exit(0)
  }
  const crash = (e: unknown) => { finished = true; console.error(e); process.exit(1) }

  // One POST through the router; its answer must end within 5 seconds.
  async function post(body: unknown, headers: Record<string, string> = {}, signedIn = true) {
    const request = new Request('http://127.0.0.1/mcp', { method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } })
    const res = await mcpEntry.fetch(request, { parsedBody: body, ...(signedIn ? { authInfo: authInfoFor(ctx) } : {}) })
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('the answer was still open after 5 s')), 5000)
    })
    try {
      return { status: res.status, type: res.headers.get('content-type'), text: await Promise.race([res.text(), late]) }
    } finally { clearTimeout(timer) }
  }
  let lastId = 0
  // A 2026-07-28 request with its envelope and headers, and a 2025-era one; each answer carries the id sent.
  const modern = async (method: string, params: Record<string, unknown> = {}, mcpName?: string) => {
    const id = ++lastId
    return { id, ...await post({ jsonrpc: '2.0', id, method, params: { ...params, _meta: META } },
      headersFor(method, mcpName)) }
  }
  const legacy = async (method: string, params: Record<string, unknown> = {}) => {
    const id = ++lastId
    return { id, ...await post({ jsonrpc: '2.0', id, method, params }) }
  }
  return { ctx, spend, check, done, crash, post, modern, legacy }
}
