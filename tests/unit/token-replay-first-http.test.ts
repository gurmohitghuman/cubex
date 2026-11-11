// An HTTP API start sent again with its idempotency key answers the run its first call started (replayed: true),
// whatever changed since: the key is read before anything that reads the sheet, saved keys or webhooks. A cURL
// command whose key save_keys named (its column exists now, its key is saved), the same with save_keys: true and
// the saved key deleted since (the start would save it again), and a plain URL whose webhook was deleted since;
// over the service, /api/v1 and MCP. Each retry, sent more times than the token's run-start window holds, makes no
// run, saves no key and takes no slot: a new start goes through after. The same key with other arguments is still
// refused. The job queue only records: no run is worked and nothing is sent.
import assert from 'node:assert/strict'
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
import hooksMod from '../../server/src/services/run-hooks'
import runsMod from '../../server/src/routes/api-v1-runs'
import keysMod from '../../server/src/routes/settings-api-keys'
import mcpMod from '../../server/src/mcp/build-server'
const { MCP_RUN_STARTS_PER_MIN } = constMod as typeof import('../../server/src/lib/api-v1-constants')
const { signToken } = authMod as typeof import('../../server/src/lib/auth')
const { tokenStartHttpRun } = tokenStartMod as typeof import('../../server/src/services/run-start-token-http')
const { createRunWebhook, deleteRunWebhook } = hooksMod as typeof import('../../server/src/services/run-hooks')
const { default: v1Runs } = runsMod as unknown as { default: express.Router }
const { default: keyRoutes } = keysMod as unknown as { default: express.Router }
const { buildMcpServer } = mcpMod as typeof import('../../server/src/mcp/build-server')
const { db, uid, ok, done, idle, sheet } = undoKit('token-replay-first-http')
console.error = () => {}

// The one Sidequest the server's queue.ts holds: its enqueue only records.
const { Sidequest } = createRequire(path.resolve('server/src/queue.ts'))('sidequest')
Sidequest.build = () => ({ enqueue: async () => ({}) })
// A run webhook's address must look public: the e2e shim resolves *.cubex-e2e.invalid so (nothing is sent).
process.env.E2E_RECEIVER_PORT = '9'
createRequire(import.meta.url)('../e2e/net-shim.cjs')

const SCOPES = new Set(['read', 'write', 'run', 'secrets'] as const)
const app = express()
app.use(express.json())
app.use(cookieParser())
app.use('/v1', (req, _res, next) => {
  Object.assign(req, { userId: uid, accessTokenId: 'tok-v1', tokenScopes: SCOPES })
  next()
}, v1Runs)
app.use('/api/settings', keyRoutes)
const server = app.listen(0)
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const cookie = `cubex_session=${signToken({ userId: uid, sessionEpoch: 0 })}`
const mcp = buildMcpServer({ userId: uid, tokenId: 'tok-mcp', tokenName: 'n', scopes: SCOPES })
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
await mcp.connect(serverSide)
const client = new Client({ name: 'unit', version: '1.0.0' })
await client.connect(clientSide)

type Answer = { status?: number; ok?: Record<string, unknown>; fail?: string; message?: string }
type Args = Record<string, unknown> & { sheet_id: string }
// One start over each surface, its answer in one shape: what the service answers, REST's status and body, and
// MCP's parsed text (isError as a fail).
const SURFACES: Record<string, (a: Args) => Promise<Answer>> = {
  service: async a => {
    const r = await tokenStartHttpRun({ userId: uid, tokenId: 'tok-service', scopes: new Set(SCOPES) }, a)
    return 'fail' in r ? { fail: r.fail, message: r.message } : { ok: { ...r.ok }, status: r.started ? 202 : 200 }
  },
  rest: async ({ sheet_id, ...body }) => {
    const res = await fetch(`${base}/v1/sheets/${sheet_id}/http-runs`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const json = await res.json() as Record<string, unknown>
    return res.ok ? { ok: json, status: res.status } : { status: res.status, message: json.error as string }
  },
  mcp: async a => {
    const res = await client.callTool({ name: 'run_http_enrichment', arguments: a }) as
      { content: Array<{ text: string }>; isError?: boolean }
    const json = JSON.parse(res.content[0].text) as Record<string, unknown>
    return res.isError ? { fail: 'error', message: json.error as string } : { ok: json }
  },
}

// Each case's own key (one saved with the same value would be used instead), built at runtime.
const curlWith = (tag: string) => `curl 'https://api.example.com/find?n={{Name}}' -H 'Authorization: Bearer `
  + `${['sk', 'proj', `replay${tag}0123456789abcdefgh`].join('-')}'`
const fresh = () => sheet([{ Name: 'ada' }, { Name: 'bob' }], ['Name'])
const runsOn = (sid: string) => db.prepare('SELECT COUNT(*) FROM http_runs WHERE sheet_id = ?').pluck().get(sid)
const keyNames = () => db.prepare('SELECT name FROM api_keys WHERE user_id = ? ORDER BY name').pluck().all(uid)
const CONFLICT = 'Idempotency key was already used with different arguments.'
// More retries than the token's run-start window holds: had one taken a slot, the next new start would be refused.
const TRIES = MCP_RUN_STARTS_PER_MIN + 1

// Starts `args` with `key`, changes the sheet with `change`, then retries it TRIES times: each answers the first
// start, replayed, with no run made and no key saved; then the first key with other arguments is refused as
// before, and a new key starts (the window is untouched).
async function replays(surface: string, args: Args, key: string,
  change: (first: Record<string, unknown>) => Promise<void> | void,
  refusedNow: (a: Args) => Promise<Answer>) {
  const start = SURFACES[surface]
  const first = await start({ ...args, idempotency_key: key })
  assert.ok(first.ok && first.ok.run_id && first.status !== 200, `${surface}: ${JSON.stringify(first)}`)
  await idle(args.sheet_id)
  await change(first.ok)
  const now = await refusedNow(args)
  assert.ok(!now.ok, `${surface}: without its key the same start is refused now: ${JSON.stringify(now)}`)
  const runs = runsOn(args.sheet_id), keys = keyNames()
  const want = { ...first.ok, replayed: true, ...(first.status ? { status: 200 } : {}) }
  for (let i = 0; i < TRIES; i++) {
    const again = await start({ ...args, idempotency_key: key })
    assert.deepEqual({ ...again.ok, ...(again.status ? { status: again.status } : {}) }, want,
      `${surface} try ${i}: ${JSON.stringify(again)}`)
  }
  assert.equal(runsOn(args.sheet_id), runs, `${surface}: no second run`)
  assert.deepEqual(keyNames(), keys, `${surface}: no key saved`)
  // Other columns and no webhook, so the sheet as it is now refuses neither.
  const elsewhere = (column: string) => ({ ...args, webhook_id: undefined, master_column_name: column,
    response_mapping: [{ json_path: '$.ok', column_name: `${column} got` }] })
  const other = await start({ ...elsewhere('Other'), idempotency_key: key })
  assert.equal(other.message, CONFLICT, `${surface}: other arguments: ${JSON.stringify(other)}`)
  const next = await start({ ...elsewhere('Next'), idempotency_key: `${key}-next` })
  assert.ok(next.ok && next.ok.run_id, `${surface}: a new start after the retries: ${JSON.stringify(next)}`)
}

for (const surface of Object.keys(SURFACES)) {
  await ok(`${surface}: a cURL start whose key save_keys named, retried once its column exists and its key is saved, `
    + `answers the first start ${TRIES} times`, async () => {
    const sid = fresh()
    const name = `named_${surface}`
    const args = { sheet_id: sid, curl: curlWith(`Named${surface}`), save_keys: { 'Authorization header': name },
      master_column_name: 'Find', response_mapping: [{ json_path: '$.ok', column_name: 'Got' }] }
    await replays(surface, args, `curl-named-${surface}`, () => {
      assert.ok(keyNames().includes(name), 'the first start saved its key')
    }, async a => {
      const now = await SURFACES[surface](a)
      assert.equal(now.message, 'A column named "Find" already exists. Choose a different name.')
      return now
    })
  })

  await ok(`${surface}: a cURL start with save_keys: true, retried after its saved key was deleted, answers the first `
    + 'start and saves nothing', async () => {
    const sid = fresh()
    const args = { sheet_id: sid, curl: curlWith(`Gone${surface}`), save_keys: true,
      master_column_name: 'Find', response_mapping: [{ json_path: '$.ok', column_name: 'Got' }] }
    await replays(surface, args, `curl-deleted-${surface}`, async first => {
      const [name] = first.saved_keys as string[]
      const id = db.prepare('SELECT id FROM api_keys WHERE user_id = ? AND name = ?').pluck().get(uid, name)
      const res = await fetch(`${base}/api/settings/api-keys/${id}`, { method: 'DELETE', headers: { cookie } })
      assert.equal(res.status, 200, 'the key the first start saved, deleted')
    }, async a => {
      const now = await SURFACES[surface](a)
      assert.equal(now.message, 'A column named "Find" already exists. Choose a different name.')
      return now
    })
  })

  await ok(`${surface}: a URL start whose webhook was deleted since answers the first start`, async () => {
    const sid = fresh()
    const hook = await createRunWebhook(uid, { url: `https://hook-${surface}.cubex-e2e.invalid/done` })
    assert.ok('ok' in hook, JSON.stringify(hook))
    const args = { sheet_id: sid, url: 'https://api.example.com/ask?n={{Name}}', webhook_id: hook.ok.webhook.id,
      master_column_name: 'Ask', response_mapping: [{ json_path: '$.ok', column_name: 'Said' }] }
    await replays(surface, args, `url-hook-${surface}`, () => {
      assert.equal(deleteRunWebhook(uid, hook.ok.webhook.id), true)
    }, async a => {
      const now = await SURFACES[surface]({ ...a, master_column_name: 'Ask 2' })
      assert.match(now.message ?? '', /^webhook_id doesn't match a run webhook\./)
      return now
    })
  })
}

server.close()
done()
