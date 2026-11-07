// Paging through saved keys (services/saved-key-uses.ts): SAVED_KEYS_LISTED keys
// a call by name, keys_count whole, next_after the last listed name, and
// `after` takes it back on every surface. A name saved before API_KEY_NAME_MAX
// can be longer, so GET /api/v1/saved-keys?after= and MCP list_saved_keys'
// after take any length the request carries: a 250-character name at the edge
// of a page pages on.
import assert from 'node:assert/strict'
import express from 'express'
import { v4 as uuid } from 'uuid'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import keysMod from '../../server/src/services/saved-keys'
import cryptoMod from '../../server/src/lib/crypto'
import usesMod from '../../server/src/services/saved-key-uses'
import constMod from '../../server/src/lib/api-v1-constants'
import routeMod from '../../server/src/routes/api-v1-saved-keys'
import buildMod from '../../server/src/mcp/build-server'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { createSavedKey, validateSavedKey } = keysMod as typeof import('../../server/src/services/saved-keys')
const { encrypt } = cryptoMod as typeof import('../../server/src/lib/crypto')
const { listSavedKeys } = usesMod as typeof import('../../server/src/services/saved-key-uses')
const { SAVED_KEYS_LISTED } = constMod as typeof import('../../server/src/lib/api-v1-constants')
const { default: savedKeysRouter } = routeMod as unknown as { default: express.Router }
const { buildMcpServer } = buildMod as typeof import('../../server/src/mcp/build-server')
if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
const ok = async (label: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
type Page = { keys: Array<{ name: string }>; keys_count: number; next_after?: string }

// A new user with these keys, each checked and saved as Settings saves it.
function userWithKeys(names: string[]): string {
  const user = uuid()
  db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(user, 'x')
  for (const name of names) {
    const input = validateSavedKey({ name, key_type: 'bearer', key_value: 'k'.repeat(16) })
    assert.ok(typeof input !== 'string', input as string)
    assert.ok('ok' in createSavedKey(user, input))
  }
  return user
}
const servicePage = (user: string, after?: string): Page => {
  const out = listSavedKeys(user, after === undefined ? {} : { after })
  assert.ok('ok' in out, JSON.stringify(out))
  return out.ok
}

await ok(`at most ${SAVED_KEYS_LISTED} keys a call, keys_count whole; next_after pages on to the rest`, () => {
  const names = Array.from({ length: SAVED_KEYS_LISTED + 3 }, (_, i) => `key_${String(i).padStart(2, '0')}`)
  const user = userWithKeys(names)
  const first = servicePage(user)
  assert.deepEqual(first.keys.map(k => k.name), names.slice(0, SAVED_KEYS_LISTED))
  assert.equal(first.keys_count, names.length)
  assert.equal(first.next_after, names[SAVED_KEYS_LISTED - 1])
  const rest = servicePage(user, first.next_after)
  assert.deepEqual(rest.keys.map(k => k.name), names.slice(SAVED_KEYS_LISTED))
  assert.equal(rest.keys_count, names.length)
  assert.equal(rest.next_after, undefined)
})

// The last key of the first page has a 250-character name, saved before names
// were capped (inserted directly: Settings now refuses it).
const LONG = `key_${String(SAVED_KEYS_LISTED - 1).padStart(2, '0')}_`.padEnd(250, 'x')
const names = Array.from({ length: SAVED_KEYS_LISTED + 3 }, (_, i) => `key_${String(i).padStart(2, '0')}`)
names[SAVED_KEYS_LISTED - 1] = LONG
const long = userWithKeys(names.filter(n => n !== LONG))
db.prepare('INSERT INTO api_keys (id, user_id, name, key_type, key_value_encrypted) VALUES (?,?,?,?,?)')
  .run(uuid(), long, LONG, 'bearer', encrypt('k'.repeat(16)))
const rest = names.slice(SAVED_KEYS_LISTED)

await ok('a 250-character name at the edge of a page: the service pages on past it', () => {
  assert.equal(LONG.length, 250)
  const first = servicePage(long)
  assert.deepEqual(first.keys.map(k => k.name), names.slice(0, SAVED_KEYS_LISTED))
  assert.equal(first.next_after, LONG)
  assert.deepEqual(servicePage(long, first.next_after).keys.map(k => k.name), rest)
})

await ok('GET /api/v1/saved-keys?after= takes the 250-character next_after', async () => {
  const app = express()
  app.use((req, _res, next) => {
    Object.assign(req, { userId: long, tokenScopes: new Set(['read']) })
    next()
  })
  app.use(savedKeysRouter)
  const server = app.listen(0)
  try {
    const port = (server.address() as { port: number }).port
    const get = (query: string) => fetch(`http://127.0.0.1:${port}/saved-keys${query}`)
    const first = await get('')
    assert.equal(first.status, 200)
    const page = await first.json() as Page
    assert.equal(page.next_after, LONG)
    const next = await get(`?after=${encodeURIComponent(page.next_after!)}`)
    assert.equal(next.status, 200, await next.clone().text())
    assert.deepEqual(((await next.json()) as Page).keys.map(k => k.name), rest)
    // Unchanged: an empty after, or two of them, is refused.
    assert.equal((await get('?after=')).status, 400)
    assert.equal((await get('?after=a&after=b')).status, 400)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

await ok('MCP list_saved_keys takes the 250-character next_after as after', async () => {
  const server = buildMcpServer({ userId: long, tokenId: 't', tokenName: 'n', scopes: new Set(['read']) })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'unit', version: '1.0.0' })
  await client.connect(clientSide)
  try {
    type Res = { content: Array<{ text: string }>; isError?: boolean }
    const call = async (args: Record<string, unknown>) => {
      const res = await client.callTool({ name: 'list_saved_keys', arguments: args }) as Res
      assert.ok(!res.isError, res.content[0]?.text)
      return JSON.parse(res.content[0].text) as Page
    }
    const first = await call({})
    assert.equal(first.next_after, LONG)
    assert.deepEqual((await call({ after: first.next_after })).keys.map(k => k.name), rest)
  } finally {
    await client.close()
    await server.close()
  }
})

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall saved key paging checks passed')
