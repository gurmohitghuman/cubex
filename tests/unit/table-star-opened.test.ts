// Over 200 lines: the star and the open over the app, REST and MCP, each refusal checked to change nothing.
// A table's star and when it was last opened (migration 064; services/table-crud.ts), over the app, /api/v1 and
// MCP. The home's list answers starred (false until starred) and last_opened_at (null until opened). PUT
// /api/tables/:id/starred stars it and answers the table; POST /api/tables/:id/opened, the app's own call, answers at
// once and the open's time is written when the write lock is free (lib/table-opened.ts), to the millisecond, never
// moved back. Neither moves updated_at. PATCH /v1/tables/:id takes starred, alone or with name: a starred that isn't
// true or false, a rename refused or a star refused changes nothing. manage_table star and unstar answer the
// table with changed [], and list_tables shows both fields, checked against the tools' output schemas strictly (as
// e2e does). A table in the trash, a hidden working table and another account's are not found.
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
// Every MCP answer object refuses a key its schema doesn't name (mcp/output-schema.ts), as in e2e.
process.env.CUBEX_TEST_STRICT_OUTPUT = '1'
const express = (await import('express')).default
const { v4: uuid } = await import('uuid')
const { Client } = await import('@modelcontextprotocol/client')
const { InMemoryTransport } = await import('@modelcontextprotocol/server')
const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { signToken } = await import('../../server/src/lib/auth')
const { generateAccessToken } = await import('../../server/src/lib/access-token')
const { applyServerMiddleware } = await import('../../server/src/lib/server-middleware')
const { buildMcpServer } = await import('../../server/src/mcp/build-server')
const { trashTable } = await import('../../server/src/services/trash-sheets')
const { noteTableOpened, tableOpensWaiting } = await import('../../server/src/lib/table-opened')
const { closeWalCheckpointer } = await import('../../server/src/lib/wal-checkpointer')
runMigrations()

const uid = uuid(), other = uuid()
for (const id of [uid, other]) db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(id, 'x')
// Made a day ago, so a write that moved updated_at would show.
const table = (name: string, owner = uid, hidden = 0) => {
  const id = uuid()
  db.prepare(`INSERT INTO tables (id,user_id,name,hidden,created_at,updated_at)
    VALUES (?,?,?,?,datetime('now','-1 day'),datetime('now','-1 day'))`).run(id, owner, name, hidden)
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position) VALUES (?,?,?,?,0)')
    .run(uuid(), id, owner, 'Sheet1')
  return id
}
const leads = table('Leads'), people = table('People'), gone = table('Gone'), working = table('Working', uid, 1)
const theirs = table('Theirs', other)
assert.ok('ok' in trashTable(uid, gone))
const stored = (id: string) => db.prepare('SELECT starred, last_opened_at, updated_at FROM tables WHERE id = ?')
  .get(id) as { starred: number; last_opened_at: string | null; updated_at: string }

const minted = generateAccessToken()
db.prepare(`INSERT INTO access_tokens (id, user_id, name, token_hash, token_prefix, scopes)
  VALUES (?,?,?,?,?,?)`).run(uuid(), uid, 'unit', minted.tokenHash, minted.tokenPrefix, 'read,write')

const app = express()
applyServerMiddleware(app, { isProduction: false })
app.use('/api/tables', (await import('../../server/src/routes/tables')).default)
app.use('/api/v1', (await import('../../server/src/routes/api-v1')).default)
const server = app.listen(0, '127.0.0.1')
await new Promise(r => server.once('listening', r))
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const session = { Cookie: `cubex_session=${signToken({ userId: uid, sessionEpoch: 0 })}` }
const token = { authorization: `Bearer ${minted.token}` }
async function call(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const res = await fetch(origin + path, { method, headers: { ...headers, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}
type Listed = { id: string; name: string; starred: boolean; last_opened_at: string | null; updated_at: string }
const home = async () => (await call('GET', '/api/tables', session)).json as Listed[]

const mcp = buildMcpServer({ userId: uid, tokenId: 't', tokenName: 'n', scopes: new Set(['read', 'write']) })
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
await mcp.connect(serverSide)
const client = new Client({ name: 'unit', version: '1.0.0' })
await client.connect(clientSide)
type Tool = { isError?: boolean; structuredContent?: Record<string, unknown>; content: Array<{ text: string }> }
const tool = async (name: string, args: Record<string, unknown>) =>
  await client.callTool({ name, arguments: args }) as Tool

// The opens noted, written.
async function written(): Promise<void> {
  for (const until = Date.now() + 5000; tableOpensWaiting() > 0;) {
    assert.ok(Date.now() < until, 'the opens were never written')
    await new Promise(r => setTimeout(r, 10))
  }
}

let failures = 0
async function check(label: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log('ok  ', label) } catch (e) {
    failures++; console.log('FAIL', label, '\n ', (e as Error).stack)
  }
}

try {
  await check('the home lists a new table not starred and never opened', async () => {
    const t = (await home()).find(x => x.id === leads)!
    assert.equal(t.starred, false)
    assert.equal(t.last_opened_at, null)
    const one = (await call('GET', `/api/tables/${leads}`, session)).json
    assert.deepEqual([one.starred, one.last_opened_at], [false, null], 'GET /:id answers both too')
  })

  await check('PUT /:id/starred stars it and answers the table; updated_at stays; false takes the star off',
    async () => {
      const before = stored(leads).updated_at
      const on = await call('PUT', `/api/tables/${leads}/starred`, session, { starred: true })
      assert.equal(on.status, 200, JSON.stringify(on.json))
      assert.deepEqual([on.json.id, on.json.name, on.json.starred], [leads, 'Leads', true])
      assert.equal((await home()).find(x => x.id === leads)!.starred, true)
      assert.equal(stored(leads).updated_at, before, 'starring changes nothing in the table')
      assert.equal((await call('PUT', `/api/tables/${people}/starred`, session, { starred: true })).status, 200)
      assert.equal((await call('PUT', `/api/tables/${people}/starred`, session, { starred: false })).json.starred,
        false)
      assert.equal(stored(people).starred, 0)
    })

  await check('PUT /:id/starred refuses a starred that isn\'t true or false, and finds no table in the trash, '
    + 'hidden or another account\'s', async () => {
    const bad = await call('PUT', `/api/tables/${people}/starred`, session, { starred: 'yes' })
    assert.deepEqual([bad.status, bad.json.error], [400, 'starred must be true or false.'])
    assert.equal(stored(people).starred, 0)
    for (const id of [gone, working, theirs, uuid()]) {
      assert.equal((await call('PUT', `/api/tables/${id}/starred`, session, { starred: true })).status, 404, id)
      assert.equal(stored(id)?.starred ?? 0, 0)
    }
  })

  await check('POST /:id/opened answers at once; the open is written to the millisecond, newest later, never moved '
    + 'back; updated_at stays', async () => {
    const before = stored(people).updated_at
    const t0 = Date.now()
    const first = await call('POST', `/api/tables/${people}/opened`, session)
    assert.equal(first.status, 204)
    await written()
    const at = stored(people).last_opened_at!
    assert.match(at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/)
    assert.equal(stored(people).updated_at, before, 'opening changes nothing in the table')
    const ms = Date.parse(`${at.replace(' ', 'T')}Z`)
    assert.ok(ms >= t0 - 1 && ms <= Date.now(), `${at}: when it was opened`)
    await new Promise(r => setTimeout(r, 5))
    assert.equal((await call('POST', `/api/tables/${leads}/opened`, session)).status, 204)
    await written()
    // An open noted with an earlier time than the one written leaves it.
    noteTableOpened(uid, people, ms - 60_000)
    await written()
    assert.equal(stored(people).last_opened_at, at, 'never moved back')
    const listed = await home()
    const opened = (id: string) => listed.find(x => x.id === id)!.last_opened_at!
    assert.equal(opened(people), at)
    assert.ok(opened(leads) > opened(people), `${opened(leads)} after ${opened(people)}`)
    for (const id of [gone, working, theirs, uuid()]) {
      assert.equal((await call('POST', `/api/tables/${id}/opened`, session)).status, 404, id)
    }
    assert.equal(stored(theirs).last_opened_at, null)
  })

  await check('GET /v1/tables answers starred and last_opened_at', async () => {
    const res = await call('GET', '/api/v1/tables', token)
    const t = (res.json.tables as Listed[]).find(x => x.id === leads)!
    assert.deepEqual([t.starred, typeof t.last_opened_at], [true, 'string'])
    assert.equal((res.json.tables as Listed[]).find(x => x.id === people)!.starred, false)
  })

  await check('PATCH /v1/tables/:id takes starred alone, or with name; answers id, name and starred', async () => {
    const star = await call('PATCH', `/api/v1/tables/${people}`, token, { starred: true })
    assert.deepEqual([star.status, star.json], [200, { id: people, name: 'People', starred: true }])
    const both = await call('PATCH', `/api/v1/tables/${people}`, token, { name: 'Contacts', starred: false })
    assert.deepEqual(both.json, { id: people, name: 'Contacts', starred: false })
    const name = await call('PATCH', `/api/v1/tables/${people}`, token, { name: 'People' })
    assert.deepEqual(name.json, { id: people, name: 'People', starred: false }, 'a rename keeps the star as it was')
  })

  await check('PATCH /v1/tables/:id with nothing, a bad starred or a name taken changes nothing', async () => {
    const none = await call('PATCH', `/api/v1/tables/${people}`, token, {})
    assert.equal(none.status, 400)
    assert.match(none.json.error, /^Send name to rename the table, starred \(true or false\) to star it, or both\.$/)
    const bad = await call('PATCH', `/api/v1/tables/${people}`, token, { name: 'Renamed', starred: 1 })
    assert.deepEqual([bad.status, bad.json.error], [400, 'starred must be true or false.'])
    const taken = await call('PATCH', `/api/v1/tables/${people}`, token, { name: 'Leads', starred: true })
    assert.equal(taken.status, 409)
    const now = db.prepare('SELECT name, starred FROM tables WHERE id = ?').get(people)
    assert.deepEqual(now, { name: 'People', starred: 0 })
    // A hidden working table can be renamed but not starred: refused, and the rename undone with it.
    const hidden = await call('PATCH', `/api/v1/tables/${working}`, token, { name: 'Shown', starred: true })
    assert.equal(hidden.status, 404)
    assert.deepEqual(db.prepare('SELECT name, starred FROM tables WHERE id = ?').get(working),
      { name: 'Working', starred: 0 })
    assert.equal((await call('PATCH', `/api/v1/tables/${theirs}`, token, { starred: true })).status, 404)
  })

  await check('manage_table star and unstar answer the table with changed []; list_tables shows both fields',
    async () => {
      const star = await tool('manage_table', { action: 'star', table_id: people })
      assert.ok(!star.isError, star.content[0].text)
      assert.deepEqual(star.structuredContent, { id: people, name: 'People', starred: true, changed: [] })
      const listed = await tool('list_tables', {})
      assert.ok(!listed.isError, listed.content[0].text)
      const tables = (listed.structuredContent as { tables: Listed[] }).tables
      const p = tables.find(x => x.id === people)!
      assert.deepEqual([p.starred, typeof p.last_opened_at], [true, 'string'])
      assert.equal(tables.some(x => x.id === gone || x.id === working || x.id === theirs), false)
      const unstar = await tool('manage_table', { action: 'unstar', table_id: people })
      assert.deepEqual(unstar.structuredContent, { id: people, name: 'People', starred: false, changed: [] })
      assert.equal(stored(people).starred, 0)
    })

  await check('manage_table star needs a table of the account\'s', async () => {
    const missing = await tool('manage_table', { action: 'star' })
    assert.equal(missing.isError, true)
    assert.match(missing.content[0].text, /table_id is required for star/)
    for (const id of [gone, theirs]) {
      const out = await tool('manage_table', { action: 'star', table_id: id })
      assert.equal(out.isError, true, id)
      assert.match(out.content[0].text, /Table not found/)
    }
    assert.equal(stored(theirs).starred, 0)
  })
} finally {
  await client.close()
  await new Promise(r => server.close(r))
  await closeWalCheckpointer()
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exitCode = 1 }
else console.log('All table-star-opened assertions passed.')
