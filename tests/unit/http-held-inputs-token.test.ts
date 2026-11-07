// What a token sees while a column an HTTP API request reads is held by another run (lib/http-held-inputs.ts):
// a start retried with its idempotency key answers the run the first call started (replayed), while a new key
// and an estimate are refused; a rerun over /api/v1 or MCP control_run is refused before it takes a run-start
// slot, so retrying it while the hold lasts never uses up the token's window. Once the clear is done each goes
// through. The job queue only records: no run is worked and nothing is sent.
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { v4 as uuid } from 'uuid'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { undoKit } from './run-undo-kit'
import cellsMod from '../../server/src/lib/placeholder-cells'
import placeholdersMod from '../../server/src/lib/run-placeholders'
import constMod from '../../server/src/lib/api-v1-constants'
import tokenStartMod from '../../server/src/services/run-start-token-http'
import v1Mod from '../../server/src/routes/api-v1-run-control'
import mcpMod from '../../server/src/mcp/build-server'
const { seedProcessingPlaceholders } = cellsMod as typeof import('../../server/src/lib/placeholder-cells')
const { clearRunPlaceholders } = placeholdersMod as typeof import('../../server/src/lib/run-placeholders')
const { MCP_RUN_STARTS_PER_MIN } = constMod as typeof import('../../server/src/lib/api-v1-constants')
const { tokenStartHttpRun } = tokenStartMod as typeof import('../../server/src/services/run-start-token-http')
const { default: v1Router } = v1Mod as unknown as { default: express.Router }
const { buildMcpServer } = mcpMod as typeof import('../../server/src/mcp/build-server')
const { db, uid, ok, done, idle, sheet } = undoKit('http-held-inputs-token')
console.error = () => {}

// The one Sidequest the server's queue.ts holds: its enqueue only records.
const { Sidequest } = createRequire(path.resolve('server/src/queue.ts'))('sidequest')
Sidequest.build = () => ({ enqueue: async () => ({}) })

const SCOPES = new Set(['read', 'write', 'run'] as const)
const app = express()
app.use(express.json())
app.use('/v1', (req, _res, next) => {
  Object.assign(req, { userId: uid, accessTokenId: 'tok-v1', tokenScopes: SCOPES })
  next()
}, v1Router)
const server = app.listen(0)
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const mcp = buildMcpServer({ userId: uid, tokenId: 'tok-mcp', tokenName: 'n', scopes: SCOPES })
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
await mcp.connect(serverSide)
const client = new Client({ name: 'unit', version: '1.0.0' })
await client.connect(clientSide)

const GOING = 'The request reads "Answer", which a run that hasn\'t finished is still filling. '
  + 'Wait for that run to finish (or stop it), then try again.'
const BACK = 'The request reads "Answer", which is getting back what it held before a stopped run. '
  + 'Try again in a moment.'
const fresh = (more: string[] = []) => sheet([{ Name: 'ada', Answer: 'Old A' }, { Name: 'bob', Answer: 'Old B' }],
  ['Name', 'Answer', ...more])
const runsOn = (sid: string) => db.prepare('SELECT COUNT(*) FROM http_runs WHERE sheet_id = ?').pluck().get(sid)
// A rerun of Answer running, its ⏳ in every row; stop() as a cancel leaves it, back() finishes its clear.
async function hold(sid: string) {
  const run = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,'{}','running','Answer')`).run(run, sid, uid)
  await seedProcessingPlaceholders({ run: { kind: 'http', id: run }, sheetId: sid, userId: uid, columns: ['Answer'],
    targets: null, lastRow: 1, live: () => true })
  return {
    stop: () => db.prepare(`UPDATE http_runs SET status = 'cancelled', placeholder_work = 'clearing'
      WHERE id = ?`).run(run),
    back: () => clearRunPlaceholders('http', run),
  }
}

await ok('a token start retried with its key while a column it reads is held: the first run, replayed; a new key '
  + 'and an estimate are refused, going and clearing; after the clear the new key starts', async () => {
  const sid = fresh()
  const c = { userId: uid, tokenId: 'tok-start', scopes: new Set<string>(SCOPES) }
  const args = (n: string, key?: string) => ({ sheet_id: sid, url: 'https://api.example.com/ask', method: 'POST',
    body: '{"answer":"{{Answer}}","name":"{{Name}}"}', master_column_name: `Ask${n}`,
    response_mapping: [{ json_path: '$.ok', column_name: `Got${n}` }], ...(key ? { idempotency_key: key } : {}) })
  const first = await tokenStartHttpRun(c, args('', 'K'))
  assert.ok('ok' in first && first.started, JSON.stringify(first))
  await idle(sid)
  const h = await hold(sid)
  assert.equal(runsOn(sid), 2)
  assert.deepEqual(await tokenStartHttpRun(c, args('', 'K')), { ok: { ...first.ok, replayed: true }, started: false })
  const refused = [GOING, BACK].map(message => ({ fail: 'conflict', message }))
  for (const want of refused) {
    if (want === refused[1]) h.stop()
    assert.deepEqual(await tokenStartHttpRun(c, args(' 2', 'K2')), want, 'a new key')
    assert.deepEqual(await tokenStartHttpRun(c, { ...args(' 2'), estimate_only: true }), want, 'an estimate')
  }
  assert.equal(runsOn(sid), 2, 'no run made')
  await h.back()
  const second = await tokenStartHttpRun(c, args(' 2', 'K2'))
  assert.ok('ok' in second && second.started, JSON.stringify(second))
})

// Push's earlier run, done: its request reads {{Answer}}.
function pushRun(sid: string): string {
  const id = uuid()
  const config = { requestConfig: { method: 'POST', url: 'https://api.example.com/push', headers: {},
    body: '{"answer":"{{Answer}}"}' }, responseMapping: [], previewSize: 3 }
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,?,'completed','Push')`).run(id, sid, uid, JSON.stringify(config))
  return id
}
// One more try than the token's window holds, then the same once the hold is over.
const TRIES = MCP_RUN_STARTS_PER_MIN + 1

await ok(`a REST rerun refused ${TRIES} times while a column it reads is held takes no run-start slot`, async () => {
  const sid = fresh(['Push'])
  const id = pushRun(sid)
  const h = await hold(sid)
  const rerun = async () => {
    const res = await fetch(`${base}/v1/http-runs/${id}/rerun`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{}' })
    return { status: res.status, json: await res.json() as Record<string, unknown> }
  }
  for (let i = 0; i < TRIES; i++) assert.deepEqual(await rerun(), { status: 409, json: { error: GOING } }, `try ${i}`)
  h.stop()
  assert.deepEqual(await rerun(), { status: 409, json: { error: BACK } })
  assert.equal(runsOn(sid), 2, 'no run made')
  await h.back()
  const out = await rerun()
  assert.equal(out.status, 202, JSON.stringify(out.json))
  assert.equal(out.json.target_rows, 2)
})

await ok(`an MCP rerun refused ${TRIES} times while a column it reads is held takes no run-start slot`, async () => {
  const sid = fresh(['Push'])
  const id = pushRun(sid)
  const h = await hold(sid)
  type Res = { content: Array<{ text: string }>; isError?: boolean }
  const rerun = async () => {
    const res = await client.callTool({ name: 'control_run', arguments: { action: 'rerun', run_type: 'http',
      run_id: id } }) as Res
    return { isError: !!res.isError, json: JSON.parse(res.content[0].text) as Record<string, unknown> }
  }
  for (let i = 0; i < TRIES; i++) assert.deepEqual(await rerun(), { isError: true, json: { error: GOING } }, `try ${i}`)
  h.stop()
  assert.deepEqual(await rerun(), { isError: true, json: { error: BACK } })
  assert.equal(runsOn(sid), 2, 'no run made')
  await h.back()
  const out = await rerun()
  assert.equal(out.isError, false, JSON.stringify(out.json))
  assert.equal(out.json.target_rows, 2)
})

server.close()
done()
