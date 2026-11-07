// The saved API key name cap (API_KEY_NAME_MAX, services/saved-keys.ts
// validateSavedKey): Settings saves a key with a 200-character name and renames
// one to it, and refuses 201 with a plain message. A key saved before the cap
// with a 250-character name (inserted directly) still lists, pages, resolves in
// a request, saves an edit that keeps its name and deletes; only renaming it to
// another long name is refused. The `name` lookup of GET /api/v1/saved-keys and
// MCP list_saved_keys takes any length, so every listed key, one at the cap or a
// 250-character one, is found by name. The client's copy of the cap matches.
// A pasted cURL command: saved-key-name-curl.test.ts.
import assert from 'node:assert/strict'
import express from 'express'
import cookieParser from 'cookie-parser'
import { v4 as uuid } from 'uuid'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import authMod from '../../server/src/lib/auth'
import cryptoMod from '../../server/src/lib/crypto'
import constMod from '../../server/src/lib/constants'
import keysMod from '../../server/src/services/saved-keys'
import usesMod from '../../server/src/services/saved-key-uses'
import requestMod from '../../server/src/lib/http-request-build'
import settingsMod from '../../server/src/routes/settings-api-keys'
import v1Mod from '../../server/src/routes/api-v1-saved-keys'
import mcpMod from '../../server/src/mcp/build-server'
import { API_KEY_NAME_MAX as CLIENT_API_KEY_NAME_MAX } from '../../client/src/lib/constants'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { signToken } = authMod as typeof import('../../server/src/lib/auth')
const { encrypt } = cryptoMod as typeof import('../../server/src/lib/crypto')
const { API_KEY_NAME_MAX } = constMod as typeof import('../../server/src/lib/constants')
const { validateSavedKey } = keysMod as typeof import('../../server/src/services/saved-keys')
const { listSavedKeys } = usesMod as typeof import('../../server/src/services/saved-key-uses')
const { buildRequest } = requestMod as typeof import('../../server/src/lib/http-request-build')
const { default: settingsRouter } = settingsMod as unknown as { default: express.Router }
const { default: v1Router } = v1Mod as unknown as { default: express.Router }
const { buildMcpServer } = mcpMod as typeof import('../../server/src/mcp/build-server')
if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
const ok = async (label: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const uid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
const AT_CAP = 'a'.repeat(API_KEY_NAME_MAX), RENAMED = 'c'.repeat(API_KEY_NAME_MAX)
const OVER = 'b'.repeat(API_KEY_NAME_MAX + 1)
const LEGACY = 'legacy_'.padEnd(250, 'z'), LAST = 'zeta_key'
const REFUSED = `API key name can be at most ${API_KEY_NAME_MAX} characters`
const form = (name: string, value = 'v'.repeat(20)) => ({ name, key_type: 'bearer', key_value: value })
const nameOf = (id: string) => db.prepare('SELECT name FROM api_keys WHERE id = ?').pluck().get(id)
const listed = (opts: { after?: string } = {}) => {
  const out = listSavedKeys(uid, opts)
  assert.ok('ok' in out, JSON.stringify(out))
  return out.ok.keys.map(k => k.name)
}
const sent = (name: string) => buildRequest(
  { method: 'GET', url: 'https://api.example.com/x', headers: { Authorization: `Bearer {{${name}}}` } },
  { rowData: {}, userId: uid, mode: 'live', allowSavedKeys: true, gone: [] },
).headers.Authorization

const app = express()
app.use(cookieParser())
app.use(express.json({ limit: '1mb' }))
app.use('/api/settings', settingsRouter)
app.use('/v1', (req, _res, next) => {
  Object.assign(req, { userId: uid, tokenScopes: new Set(['read']) })
  next()
}, v1Router)
const server = app.listen(0)
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
const cookie = `cubex_session=${signToken({ userId: uid, sessionEpoch: 0 })}`
const send = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as Record<string, unknown> & { keys?: Array<{ name: string }> } }
}

try {
  let atCapId = ''
  await ok('a name of 200 characters is saved; 201 is refused, with a plain message', async () => {
    assert.ok(typeof validateSavedKey(form(AT_CAP)) !== 'string')
    assert.equal(validateSavedKey(form(OVER)), REFUSED)
    const made = await send('POST', '/api/settings/api-keys', form(AT_CAP))
    assert.equal(made.status, 201, JSON.stringify(made.json))
    atCapId = made.json.id as string
    const refused = await send('POST', '/api/settings/api-keys', form(OVER))
    assert.deepEqual(refused, { status: 400, json: { error: REFUSED } })
    assert.deepEqual(listed(), [AT_CAP])
  })

  await ok('a key is renamed to 200 characters; renaming it to 201 is refused and keeps its name', async () => {
    assert.equal((await send('PUT', `/api/settings/api-keys/${atCapId}`, form(RENAMED))).status, 200)
    assert.equal(nameOf(atCapId), RENAMED)
    const refused = await send('PUT', `/api/settings/api-keys/${atCapId}`, form(OVER))
    assert.deepEqual(refused, { status: 400, json: { error: REFUSED } })
    assert.equal(nameOf(atCapId), RENAMED)
  })

  // Saved before the cap: inserted directly, as Settings now refuses it.
  const legacyId = uuid()
  db.prepare('INSERT INTO api_keys (id, user_id, name, key_type, key_value_encrypted) VALUES (?,?,?,?,?)')
    .run(legacyId, uid, LEGACY, 'bearer', encrypt('legacy-value-1234'))
  assert.equal((await send('POST', '/api/settings/api-keys', form(LAST))).status, 201)

  await ok('a 250-character name saved before the cap lists and pages, on the service and REST', async () => {
    assert.deepEqual(listed(), [RENAMED, LEGACY, LAST])
    assert.deepEqual(listed({ after: RENAMED }), [LEGACY, LAST])
    assert.deepEqual(listed({ after: LEGACY }), [LAST])
    const all = await send('GET', '/v1/saved-keys')
    assert.deepEqual(all.json.keys?.map(k => k.name), [RENAMED, LEGACY, LAST])
    const next = await send('GET', `/v1/saved-keys?after=${encodeURIComponent(LEGACY)}`)
    assert.equal(next.status, 200, JSON.stringify(next.json))
    assert.deepEqual(next.json.keys?.map(k => k.name), [LAST])
  })

  await ok('... resolves in a request, saves an edit that keeps its name, refuses a long rename, deletes', async () => {
    assert.equal(sent(LEGACY), 'Bearer legacy-value-1234')
    const edited = await send('PUT', `/api/settings/api-keys/${legacyId}`, form(LEGACY, 'legacy-value-5678'))
    assert.equal(edited.status, 200, JSON.stringify(edited.json))
    assert.equal(sent(LEGACY), 'Bearer legacy-value-5678')
    const renamed = await send('PUT', `/api/settings/api-keys/${legacyId}`, form('legacy_'.padEnd(250, 'y')))
    assert.deepEqual(renamed, { status: 400, json: { error: REFUSED } })
    assert.equal(nameOf(legacyId), LEGACY)
    assert.equal((await send('DELETE', `/api/settings/api-keys/${legacyId}`)).status, 200)
    assert.deepEqual(listed(), [RENAMED, LAST])
  })

  // Saved before the cap and kept: the lookup finds it by its whole name.
  const OLDER = 'older_'.padEnd(250, 'q'), MISSING = 'older_'.padEnd(250, 'x')
  db.prepare('INSERT INTO api_keys (id, user_id, name, key_type, key_value_encrypted) VALUES (?,?,?,?,?)')
    .run(uuid(), uid, OLDER, 'bearer', encrypt('older-value-1234'))
  const notFound = `There's no saved key named "${MISSING.slice(0, 64)}".`

  await ok('the name lookup takes any length: REST and MCP find a 200- and a 250-character key by name', async () => {
    for (const name of [RENAMED, OLDER]) {
      const found = await send('GET', `/v1/saved-keys?name=${name}`)
      assert.equal(found.status, 200, JSON.stringify(found.json))
      assert.deepEqual(found.json.keys?.map(k => k.name), [name])
    }
    assert.deepEqual(await send('GET', `/v1/saved-keys?name=${MISSING}`), { status: 404, json: { error: notFound } })
    const mcp = buildMcpServer({ userId: uid, tokenId: 't', tokenName: 'n', scopes: new Set(['read']) })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await mcp.connect(serverSide)
    const client = new Client({ name: 'unit', version: '1.0.0' })
    await client.connect(clientSide)
    try {
      type Res = { content: Array<{ text: string }>; isError?: boolean }
      const call = (name: string) => client.callTool({ name: 'list_saved_keys', arguments: { name } }) as Promise<Res>
      for (const name of [RENAMED, OLDER]) {
        const res = await call(name)
        assert.ok(!res.isError, res.content[0]?.text)
        assert.deepEqual((JSON.parse(res.content[0].text) as { keys: Array<{ name: string }> }).keys.map(k => k.name),
          [name])
      }
      const missing = await call(MISSING)
      assert.ok(missing.isError)
      assert.deepEqual(JSON.parse(missing.content[0].text), { error: notFound })
    } finally {
      await client.close()
      await mcp.close()
    }
  })

  await ok("the client's copy of the cap is the server's", () => {
    assert.equal(CLIENT_API_KEY_NAME_MAX, API_KEY_NAME_MAX)
  })
} finally {
  await new Promise(resolve => server.close(resolve))
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall saved key name cap checks passed')
