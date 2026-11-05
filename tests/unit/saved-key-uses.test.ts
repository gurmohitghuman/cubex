// Saved keys by name and where they're used (services/saved-key-uses.ts, MCP
// list_saved_keys, GET /api/v1/saved-keys): a column counts by its newest run
// only, in a listed column of a live sheet; waterfall steps and both token
// forms count; trashed sheets and tables, deleted columns and other users
// don't; setups that name a key are listed; lists stop at SAVED_KEY_USES_LISTED
// with whole counts. And the answer can't hold any byte of a saved value, nor
// its hash, its ciphertext or any field but the listed ones.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import keysMod from '../../server/src/services/saved-keys'
import usesMod from '../../server/src/services/saved-key-uses'
import constMod from '../../server/src/lib/api-v1-constants'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { createSavedKey } = keysMod as typeof import('../../server/src/services/saved-keys')
const { listSavedKeys } = usesMod as typeof import('../../server/src/services/saved-key-uses')
const { SAVED_KEY_USES_LISTED } = constMod as typeof import('../../server/src/lib/api-v1-constants')
if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
const ok = (label: string, fn: () => void) => {
  try { fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const uid = uuid(), other = uuid()
for (const u of [uid, other]) db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(u, 'x')
// Built from pieces, so no key-shaped string sits in the source. Every byte of
// the second is >= 0x80: none can appear in an answer of ASCII names and ids.
const ASCII_VALUE = ['Q9zR7wX2', 'pL4mN8vB', 'jKyT'].join('')
const HIGH_VALUE = ['\u2603\u00c6\u00d8', '\u00c5\u00a7\u00b6\u00a4', '\u2603\u00c6\u00d8\u00c5'].join('')
for (const [name, value] of [['openai', ASCII_VALUE], ['Stripe_Key', HIGH_VALUE], ['unused_key', ASCII_VALUE]]) {
  assert.ok('ok' in createSavedKey(uid, { name, key_type: 'bearer', key_value: value, description: value }))
}
assert.ok('ok' in createSavedKey(other,
  { name: 'openai', key_type: 'bearer', key_value: ASCII_VALUE, description: null }))

let position = 0
function table(name: string, user = uid, trashed = false): string {
  const id = uuid()
  db.prepare('INSERT INTO tables (id,user_id,name,trash_id) VALUES (?,?,?,?)').run(id, user, name, trashed ? 7 : null)
  return id
}
function sheet(tableId: string, name: string, columns: string[], user = uid, trashed = false): string {
  const id = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order,trash_id) VALUES (?,?,?,?,?,?,?)')
    .run(id, tableId, user, name, position++, JSON.stringify(columns), trashed ? 7 : null)
  return id
}
function run(sheetId: string, column: string, config: unknown, hoursAgo = 0, user = uid) {
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name, created_at)
    VALUES (?,?,?,?,'completed',?, datetime('now', ?))`)
    .run(uuid(), sheetId, user, JSON.stringify(config), column, `-${hoursAgo} hours`)
}
const http = (url: string, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) => ({
  requestConfig: { method: 'GET', url, headers, ...extra }, responseMapping: [{ jsonPath: '$.a', columnName: 'A' }],
})

const T1 = table('Leads')
const A = sheet(T1, 'People', ['Website', 'Lookup', 'Old', 'Plain', 'Enrich'])
// The column's setup is its newest run: the older one named Stripe_Key, the newest names openai.
run(A, 'Lookup', http('https://api.example.com/{{Stripe_Key}}'), 48)
run(A, 'Lookup', http('https://api.example.com/{{Website}}', { Authorization: 'Bearer {{OpenAI}}' }))
db.prepare(`INSERT INTO autorun_columns (id, user_id, sheet_id, status_column, kind, enabled)
  VALUES (?,?,?,?,'http',1)`).run(uuid(), uid, A, 'Lookup')
// A deleted column's token is the column, never a key; a column not listed isn't a use.
run(A, 'Old', http('https://api.example.com/{{openai}}', {}, { goneColumns: ['openai'] }))
run(A, 'Gone', http('https://api.example.com/{{openai}}'))
run(A, 'Enrich', { ...http('https://treg.example/run'), enrichment: { v: 1, toolId: 't' } })
const B = sheet(T1, 'Companies', ['Domain', 'Email'])
run(B, 'Email', {
  ...http('https://none.example'),
  waterfall: { v: 1, steps: [{ choices: { kind: 'http', method: 'get', url: 'https://x.example/q',
    headers: { 'X-Key': '/Stripe_Key' }, body: null, valuePath: '$.a', retries: null } }] },
})
// In the trash: a sheet on its own, and a whole table with its sheet.
const D = sheet(T1, 'Old people', ['Lookup'], uid, true)
run(D, 'Lookup', http('https://api.example.com/{{openai}}'))
const C = sheet(table('Archive', uid, true), 'Archived', ['Lookup'], uid, true)
run(C, 'Lookup', http('https://api.example.com/{{openai}}'))
// Another user's sheet with the same key name.
const O = sheet(table('Theirs', other), 'Theirs', ['Lookup'], other)
run(O, 'Lookup', http('https://api.example.com/{{openai}}'), 0, other)
for (const [name, keys] of [['Lead flow', ['openai']], ['Plain flow', []]] as const) {
  db.prepare('INSERT INTO setups (id, user_id, name, spec) VALUES (?,?,?,?)')
    .run(uuid(), uid, name, JSON.stringify({ v: 1, inputs: [], keys, steps: [] }))
}

const listed = () => {
  const out = listSavedKeys(uid)
  assert.ok('ok' in out, JSON.stringify(out))
  return out.ok.keys
}
const byName = (n: string) => listed().find(k => k.name === n)!

ok('every saved key by name, with when it was saved and last changed', () => {
  assert.deepEqual(listed().map(k => k.name), ['Stripe_Key', 'openai', 'unused_key'])
  for (const k of listed()) assert.match(k.created_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/)
})

ok('a column counts by its newest run, any case of the name; auto-run is said', () => {
  assert.deepEqual(byName('openai').used_in, [{
    sheet_id: A, sheet_name: 'People', table_id: T1, table_name: 'Leads', column: 'Lookup', kind: 'http',
    auto_run: true,
  }])
  assert.equal(byName('openai').used_in_count, 1)
})

ok('a waterfall\'s HTTP step counts (the /name form too); trash, deleted columns, enrichments, others don\'t', () => {
  assert.deepEqual(byName('Stripe_Key').used_in.map(u => [u.sheet_name, u.column, u.kind, u.auto_run]),
    [['Companies', 'Email', 'waterfall', false]])
  const sheets = listed().flatMap(k => k.used_in.map(u => u.sheet_id))
  for (const s of [C, D, O]) assert.ok(!sheets.includes(s))
  assert.deepEqual(byName('unused_key').used_in, [])
})

ok('saved setups that name a key', () => {
  assert.deepEqual(byName('openai').setups.map(s => s.name), ['Lead flow'])
  assert.equal(byName('openai').setups_count, 1)
  assert.deepEqual(byName('Stripe_Key').setups, [])
})

ok('name narrows it to one key, any case; an unknown name says so', () => {
  const one = listSavedKeys(uid, 'OPENAI')
  assert.ok('ok' in one)
  assert.deepEqual(one.ok.keys.map(k => k.name), ['openai'])
  const none = listSavedKeys(uid, 'nope')
  assert.ok('fail' in none && none.fail === 'not_found')
  const empty = listSavedKeys(uuid())
  assert.deepEqual(empty, { ok: { keys: [] } })
})

ok(`at most ${SAVED_KEY_USES_LISTED} places a key, with the whole count`, () => {
  const T = table('Many')
  for (let i = 0; i < SAVED_KEY_USES_LISTED + 7; i++) {
    run(sheet(T, `S${i}`, ['Call']), 'Call', http('https://api.example.com/x', { 'X-Api-Key': '{{unused_key}}' }))
  }
  const k = byName('unused_key')
  assert.equal(k.used_in.length, SAVED_KEY_USES_LISTED)
  assert.equal(k.used_in_count, SAVED_KEY_USES_LISTED + 7)
})

ok('the answer holds no byte of a saved value, nor its hash, its ciphertext or any other field', () => {
  const text = JSON.stringify(listSavedKeys(uid))
  const bytes = Buffer.from(text, 'utf8')
  for (const b of Buffer.from(HIGH_VALUE, 'utf8')) assert.ok(!bytes.includes(b), `byte ${b} appears`)
  for (let i = 0; i + 3 <= ASCII_VALUE.length; i++) {
    assert.ok(!text.includes(ASCII_VALUE.slice(i, i + 3)), `"${ASCII_VALUE.slice(i, i + 3)}" appears`)
  }
  const stored = db.prepare('SELECT key_value_encrypted FROM api_keys WHERE user_id = ?').pluck().all(uid) as string[]
  for (const v of [ASCII_VALUE, HIGH_VALUE]) {
    for (const enc of ['hex', 'base64'] as const) {
      assert.ok(!text.includes(crypto.createHash('sha256').update(v).digest(enc).slice(0, 12)))
    }
  }
  for (const c of stored) assert.ok(!text.includes(c.slice(0, 16)))
  for (const k of listed()) {
    assert.deepEqual(Object.keys(k).sort(),
      ['created_at', 'name', 'setups', 'setups_count', 'updated_at', 'used_in', 'used_in_count'])
    for (const u of k.used_in) {
      assert.deepEqual(Object.keys(u).sort(),
        ['auto_run', 'column', 'kind', 'sheet_id', 'sheet_name', 'table_id', 'table_name'])
    }
  }
})

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall saved key listing checks passed')
