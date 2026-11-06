// Saved key names and "Paste a cURL command" (lib/curl/key-apply.ts,
// services/saved-keys.ts saveImportedKeys). Using a saved key takes its own
// name whatever its length: a 150-character key saved from Settings and a
// 250-character one saved before the cap (inserted directly) are used from the
// dialog and from an agent's save_keys. Saving a new key from a paste is held
// to CURL_KEY_NAME_MAX (a 65-character name is refused, nothing saved), and the
// write itself refuses a name over API_KEY_NAME_MAX, dry run or not, rolling
// back the keys before it, and one with characters Settings refuses.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import cryptoMod from '../../server/src/lib/crypto'
import constMod from '../../server/src/lib/constants'
import keysMod from '../../server/src/services/saved-keys'
import appMod from '../../server/src/services/curl-import-app'
import tokenMod from '../../server/src/services/curl-token'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { encrypt } = cryptoMod as typeof import('../../server/src/lib/crypto')
const { API_KEY_NAME_MAX, CURL_KEY_NAME_MAX } = constMod as typeof import('../../server/src/lib/constants')
const { createSavedKey, saveImportedKeys, validateSavedKey } =
  keysMod as typeof import('../../server/src/services/saved-keys')
const { importCurlForApp } = appMod as typeof import('../../server/src/services/curl-import-app')
const { curlForToken } = tokenMod as typeof import('../../server/src/services/curl-token')
if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
const ok = (label: string, fn: () => void) => {
  try { fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const uid = uuid(), tableId = uuid(), sheetId = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(tableId, uid, 'T')
db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
  .run(sheetId, tableId, uid, 'S', JSON.stringify(['Domain']))
const names = () => db.prepare('SELECT name FROM api_keys WHERE user_id = ? ORDER BY name').pluck().all(uid)
const cmd = (secret: string) => `curl https://api.example.com/v1/x -H 'Authorization: Bearer ${secret}'`
const app = (secret: string, choice?: unknown) =>
  importCurlForApp(uid, sheetId, cmd(secret), choice === undefined ? undefined : { 'header:0': choice })
const agent = { userId: uid, scopes: new Set(['read', 'write', 'run', 'secrets']) }

// 150 characters, saved through Settings' own check; 250, saved before the cap.
const MID = 'mid_'.padEnd(150, 'm'), MID_VALUE = 'sk-mid-value-1234567890abcdef'
const LEGACY = 'legacy_'.padEnd(250, 'z'), LEGACY_VALUE = 'sk-legacy-value-1234567890abcdef'
const mid = validateSavedKey({ name: MID, key_type: 'bearer', key_value: MID_VALUE })
assert.ok(typeof mid !== 'string', String(mid))
assert.ok('ok' in createSavedKey(uid, mid))
db.prepare('INSERT INTO api_keys (id, user_id, name, key_type, key_value_encrypted) VALUES (?,?,?,?,?)')
  .run(uuid(), uid, LEGACY, 'bearer', encrypt(LEGACY_VALUE))

for (const [label, name, value] of [['150', MID, MID_VALUE], ['250', LEGACY, LEGACY_VALUE]]) {
  ok(`a ${label}-character saved key is offered for its value and used from the dialog`, () => {
    const asked = app(value)
    assert.ok('ok' in asked && asked.ok.needsKeys, JSON.stringify(asked))
    assert.equal(asked.ok.keys[0].existingKey, name)
    const used = app(value, { use: name })
    assert.ok('ok' in used && !used.ok.needsKeys, JSON.stringify(used))
    assert.equal(used.ok.request.headers.find(h => h.key === 'Authorization')?.value, `Bearer {{${name}}}`)
    assert.deepEqual(used.ok.savedKeys, [])
  })

  ok(`... and by an agent's save_keys: true, which uses the key holding that value`, () => {
    const t = curlForToken(agent, sheetId, cmd(value), true)
    assert.ok('ok' in t, JSON.stringify(t))
    assert.equal(t.ok.prepared.request.headers.Authorization, `Bearer {{${name}}}`)
    assert.deepEqual(t.ok.prepared.keys, [])
  })
}

const before = names()
const SECRET = 'sk-new-paste-value-1234567890'
ok(`a pasted command saves a new key named with ${CURL_KEY_NAME_MAX} characters, not one more`, () => {
  const long = 'k'.repeat(CURL_KEY_NAME_MAX + 1)
  const refused = app(SECRET, { save: long })
  assert.deepEqual(refused, {
    fail: 'bad_request', message: `"${long.slice(0, 40)}" can't be a key name: use letters, numbers, _ and -.`,
  })
  assert.deepEqual(names(), before)
  const at = 'k'.repeat(CURL_KEY_NAME_MAX)
  const saved = app(SECRET, { save: at })
  assert.ok('ok' in saved && !saved.ok.needsKeys, JSON.stringify(saved))
  assert.deepEqual(saved.ok.savedKeys, [at])
  assert.deepEqual(names(), [...before, at].sort())
})

ok(`the write refuses a key name over ${API_KEY_NAME_MAX} characters, dry run or not, saving none of the batch`, () => {
  const key = (name: string) => ({ name, value: 'v'.repeat(20), key_type: 'api_key' as const, description: '' })
  const AT_CAP = 'a'.repeat(API_KEY_NAME_MAX), OVER = 'b'.repeat(API_KEY_NAME_MAX + 1)
  const refused = { fail: 'bad_request', message: `API key name can be at most ${API_KEY_NAME_MAX} characters` }
  const now = names()
  assert.deepEqual(saveImportedKeys(uid, [], [key(OVER)], true), refused)
  assert.deepEqual(saveImportedKeys(uid, [], [key(AT_CAP), key(OVER)]), refused)
  assert.deepEqual(names(), now)
  assert.deepEqual(saveImportedKeys(uid, [], [key(AT_CAP)]), { ok: [AT_CAP] })
  assert.deepEqual(names(), [...now, AT_CAP].sort())
})

ok('the write refuses a key name with characters Settings refuses, dry run or not', () => {
  const key = { name: 'a}}x{{b', value: 'v'.repeat(20), key_type: 'api_key' as const, description: '' }
  const settings = validateSavedKey({ name: key.name, key_type: 'bearer', key_value: key.value })
  assert.match(String(settings), /can only contain letters, numbers, underscores, and hyphens/)
  const refused = { fail: 'bad_request', message: settings }
  const now = names()
  assert.deepEqual(saveImportedKeys(uid, [], [key], true), refused)
  assert.deepEqual(saveImportedKeys(uid, [], [key]), refused)
  assert.deepEqual(names(), now)
})

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall saved key name cURL checks passed')
