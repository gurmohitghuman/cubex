// Over 200 lines: the REST app, the MCP client and the held run serve every case; split, each would rebuild them.
// What a token sees while a column an HTTP API request reads is held by another run (lib/http-held-inputs.ts):
// a start retried with its idempotency key answers the run the first call started (replayed), while a new key
// (a cURL command with save_keys too, which saves no key) and an estimate are refused; a rerun over /api/v1 or
// MCP control_run is refused before it takes a run-start slot, so retrying any of them while the hold lasts never
// uses up the token's window. A rerun another refusal comes first for (no 'secrets' scope, a column it reads
// deleted, a run still active on its own column) gets that one at once, before it takes a slot. Once the clear
// is done each goes through. The job queue only records: no run is worked and nothing is sent.
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
import keysMod from '../../server/src/services/saved-keys'
import v1Mod from '../../server/src/routes/api-v1-run-control'
import mcpMod from '../../server/src/mcp/build-server'
import timeoutsMod from '../../server/src/lib/server-timeouts'
const { seedProcessingPlaceholders } = cellsMod as typeof import('../../server/src/lib/placeholder-cells')
const { clearRunPlaceholders } = placeholdersMod as typeof import('../../server/src/lib/run-placeholders')
const { MCP_RUN_STARTS_PER_MIN } = constMod as typeof import('../../server/src/lib/api-v1-constants')
const { tokenStartHttpRun } = tokenStartMod as typeof import('../../server/src/services/run-start-token-http')
const { createSavedKey } = keysMod as typeof import('../../server/src/services/saved-keys')
const { default: v1Router } = v1Mod as unknown as { default: express.Router }
const { buildMcpServer } = mcpMod as typeof import('../../server/src/mcp/build-server')
const { applyServerTimeouts } = timeoutsMod as typeof import('../../server/src/lib/server-timeouts')
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
applyServerTimeouts(server)
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
const keyNames = () => db.prepare('SELECT name FROM api_keys WHERE user_id = ? ORDER BY name').pluck().all(uid)
// One more try than the token's window holds: had a refusal taken a slot, the start after the hold would be refused.
const TRIES = MCP_RUN_STARTS_PER_MIN + 1
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
  assert.deepEqual(await tokenStartHttpRun(c, args('', 'K')),
    { ok: { ...first.ok, replayed: true }, started: false, changed: first.changed })
  const refused = [GOING, BACK].map(message => ({ fail: 'conflict', message }))
  for (const want of refused) {
    if (want === refused[1]) h.stop()
    for (let i = 0; i < TRIES; i++) assert.deepEqual(await tokenStartHttpRun(c, args(' 2', 'K2')), want, `try ${i}`)
    assert.deepEqual(await tokenStartHttpRun(c, { ...args(' 2'), estimate_only: true }), want, 'an estimate')
  }
  assert.equal(runsOn(sid), 2, 'no run made')
  await h.back()
  const second = await tokenStartHttpRun(c, args(' 2', 'K2'))
  assert.ok('ok' in second && second.started, JSON.stringify(second))
})

await ok(`a cURL start with save_keys refused ${TRIES} times while a column it reads is held saves no key and `
  + 'takes no run-start slot; after the clear it starts and saves it', async () => {
  const sid = fresh()
  const c = { userId: uid, tokenId: 'tok-curl', scopes: new Set<string>([...SCOPES, 'secrets']) }
  const secret = ['sk', 'proj', 'heldCURL0123456789abcdefgh'].join('-')
  const start = () => tokenStartHttpRun(c, { sheet_id: sid, idempotency_key: 'KC', save_keys: true,
    curl: `curl 'https://api.example.com/ask?a={{Answer}}' -H 'Authorization: Bearer ${secret}'`,
    master_column_name: 'Ask', response_mapping: [{ json_path: '$.ok', column_name: 'Got' }] })
  const keys = keyNames()
  const h = await hold(sid)
  for (let i = 0; i < TRIES; i++) assert.deepEqual(await start(), { fail: 'conflict', message: GOING }, `try ${i}`)
  h.stop()
  assert.deepEqual(await start(), { fail: 'conflict', message: BACK })
  assert.deepEqual(keyNames(), keys, 'no key saved while it is held')
  assert.equal(runsOn(sid), 1, 'no run made')
  await h.back()
  const out = await start()
  assert.ok('ok' in out && out.started, JSON.stringify(out))
  assert.equal((out.ok as { saved_keys: string[] }).saved_keys.length, 1)
  assert.equal(keyNames().length, keys.length + 1)
})

// Push's earlier run (done, unless `status` says otherwise): its request reads {{Answer}}, and what `more` adds.
function pushRun(sid: string, more = '', status = 'completed'): string {
  const id = uuid()
  const config = { requestConfig: { method: 'POST', url: 'https://api.example.com/push', headers: {},
    body: `{"answer":"{{Answer}}"${more}}` }, responseMapping: [], previewSize: 3 }
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,?,?,'Push')`).run(id, sid, uid, JSON.stringify(config), status)
  return id
}

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

// A rerun over each surface: REST's status and error, MCP's isError and error.
const RERUN: Record<string, (id: string) => Promise<{ refused: boolean; error: string }>> = {
  rest: async id => {
    const res = await fetch(`${base}/v1/http-runs/${id}/rerun`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{}' })
    return { refused: !res.ok, error: `${res.status} ${((await res.json()) as { error?: string }).error}` }
  },
  mcp: async id => {
    const res = await client.callTool({ name: 'control_run', arguments: { action: 'rerun', run_type: 'http',
      run_id: id } }) as { content: Array<{ text: string }>; isError?: boolean }
    const said = JSON.parse(res.content[0].text) as { error?: string }
    return { refused: !!res.isError, error: `${res.isError ? 'error' : 'ok'} ${said.error}` }
  },
}
createSavedKey(uid, { name: 'push_key', key_type: 'bearer', key_value: 'push-key-0123456789', description: null })
// Each while Answer is held: the rerun's own refusal (REST's status), which it gives before the held column's.
const FIRST: Array<{ why: string; status: number; error: string; run: (sid: string) => string }> = [
  { why: "no 'secrets' scope for the saved key its request reads", status: 403,
    error: "This run references saved API key(s): push_key. Re-running it requires the 'secrets' scope.",
    run: sid => {
      const id = pushRun(sid, ',"key":"{{push_key}}"')
      db.prepare('UPDATE http_runs SET allow_secrets = 1 WHERE id = ?').run(id)
      return id
    } },
  { why: 'a column its request reads, deleted since', status: 400,
    error: "{{Gone}} doesn't match a column of this sheet or a saved key.",
    run: sid => pushRun(sid, ',"gone":"{{Gone}}"') },
  { why: 'a run still active on its own column', status: 409,
    error: 'A run on this column is still active, or still clearing the cells of a stopped run. Wait for it to '
      + 'finish, or stop it first.', run: sid => pushRun(sid, '', 'running') },
]
// Refused TRIES times, then a rerun that goes through, by the same token: no refusal took a run-start slot.
for (const [surface, rerun] of Object.entries(RERUN)) {
  for (const f of FIRST) {
    await ok(`${surface}: a rerun with ${f.why}, while a column it reads is held, gets that refusal at once, `
      + `${TRIES} times, taking no run-start slot`, async () => {
      const sid = fresh(['Push'])
      const id = f.run(sid)
      const h = await hold(sid)
      // MCP adds how to get a missing scope (mcp/next-steps.ts).
      const more = surface === 'rest' || !f.error.includes('scope') ? '' : " A token's scopes are set when it is made: "
        + 'the user can make a token with Use saved API keys ticked in Cubex (Settings, then Agent access) and '
        + 'connect with it.'
      const want = `${surface === 'rest' ? f.status : 'error'} ${f.error}${more}`
      for (let i = 0; i < TRIES; i++) assert.deepEqual(await rerun(id), { refused: true, error: want }, `try ${i}`)
      assert.equal(runsOn(sid), 2, 'no run made')
      h.stop()
      await h.back()
      const clean = fresh(['Push'])
      const out = await rerun(pushRun(clean))
      assert.equal(out.refused, false, `a rerun after the refusals: ${out.error}`)
      assert.equal(runsOn(clean), 2)
    })
  }
}

server.close()
done()
