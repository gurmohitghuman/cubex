// "Paste a cURL command" for agents (services/curl-token.ts) against a migrated
// throwaway DB: a key needs save_keys and the 'secrets' scope, and a token
// without it learns nothing about saved keys' values; a save_keys object names
// every key; a start that would fail saves no key; nothing is written before
// commit, and a dry run writes nothing either.
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import cryptoMod from '../../server/src/lib/crypto'
import tokenMod from '../../server/src/services/curl-token'
import importMod from '../../server/src/services/curl-import'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { decrypt, encrypt } = cryptoMod as typeof import('../../server/src/lib/crypto')
const { curlForToken, curlStartProblem } = tokenMod as typeof import('../../server/src/services/curl-token')
const { commitCurlKeys } = importMod as typeof import('../../server/src/services/curl-import')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}

const uid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
const tableId = uuid(), sheetId = uuid()
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(tableId, uid, 'T')
db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
  .run(sheetId, tableId, uid, 'S', JSON.stringify(['Domain', 'Company Name']))
const keyValue = (name: string) => {
  const row = db.prepare('SELECT key_value_encrypted FROM api_keys WHERE user_id = ? AND name = ?').get(uid, name) as
    { key_value_encrypted: string } | undefined
  return row ? decrypt(row.key_value_encrypted) : undefined
}
const saveKey = (name: string, value: string) => db.prepare(
  'INSERT INTO api_keys (id, user_id, name, key_type, key_value_encrypted) VALUES (?,?,?,?,?)',
).run(uuid(), uid, name, 'api_key', encrypt(value))
const full = { userId: uid, scopes: new Set(['read', 'run', 'secrets']) }
const runOnly = { userId: uid, scopes: new Set(['read', 'run']) }

// Agents: curl + save_keys.
{
  const cmd = "curl https://api.hunter.io/v2/x -H 'X-API-Key: hunterkey1234567'"
  const none = curlForToken(full, sheetId, cmd, undefined)
  check('agent: a key without save_keys is refused, naming where', 'fail' in none
    && none.message.includes('X-API-Key header') && none.message.includes('save_keys: true')
    && none.message.includes('(hunter)')
    && !none.message.includes('hunterkey'), none)
  const noScope = curlForToken(runOnly, sheetId, cmd, true)
  check("agent: save_keys needs the 'secrets' scope", 'fail' in noScope && noScope.fail === 'forbidden', noScope)
  const named = curlForToken(full, sheetId, cmd, { 'X-API-Key header': 'hunter_io' })
  check('agent: names by label; nothing saved before commit', 'ok' in named
    && named.ok.prepared.request.headers['X-API-Key'] === '{{hunter_io}}' && keyValue('hunter_io') === undefined, named)
  if ('ok' in named) commitCurlKeys(uid, named.ok.plan, named.ok.prepared.keys)
  check('agent: commit saves it', keyValue('hunter_io') === 'hunterkey1234567')
  const reuse = curlForToken(full, sheetId, cmd, 'true')
  check('agent: a key already saved with that value is used', 'ok' in reuse
    && reuse.ok.prepared.keys.length === 0 && reuse.ok.prepared.request.headers['X-API-Key'] === '{{hunter_io}}', reuse)
  const stray = curlForToken(full, sheetId, cmd, { 'Cookie header': 'x' })
  check('agent: a label that is not in the command is refused',
    'fail' in stray && stray.message.includes('isn\'t a key'), stray)
  const missing = curlForToken(full, sheetId, 'curl https://e.com -H "Authorization: Bearer $NOT_SAVED_ANYWHERE"', true)
  check('agent: a $VAR with no saved key is refused, saying so', 'fail' in missing
    && missing.message.includes('$NOT_SAVED_ANYWHERE') && missing.message.includes('as NOT_SAVED_ANYWHERE'), missing)
  const bad = curlForToken(full, sheetId, cmd, 'yes')
  check('agent: save_keys must be true or an object', 'fail' in bad && bad.message.includes('save_keys must be'), bad)
}

// A token without 'secrets' learns nothing about saved keys' values.
{
  saveKey('basic_svc', Buffer.from('admin:hunter2').toString('base64'))
  for (const pw of ['hunter2', 'wrong']) {
    const r = curlForToken(runOnly, sheetId, `curl https://api.x.com/v1 -u admin:${pw}`, undefined)
    check(`run-only, -u admin:${pw}: forbidden, no hint of a saved value`, 'fail' in r && r.fail === 'forbidden'
      && !r.message.includes('already saved') && !r.message.includes('basic_svc'), r)
  }
  const owner = curlForToken(full, sheetId, 'curl https://api.x.com/v1 -u admin:hunter2', undefined)
  check("with 'secrets': the saved key is named", 'fail' in owner && owner.message.includes('already saved as basic_svc'), owner)
}

// A save_keys object names every key.
{
  const two = "curl https://api.acme.io/x -H 'X-API-Key: acmekey123456' -H 'X-Secret: acmesecret123456'"
  const partial = curlForToken(full, sheetId, two, { 'X-API-Key header': 'acme1' })
  check('a partial save_keys object is refused', 'fail' in partial && partial.message.includes('names every key')
    && partial.message.includes('"X-Secret header"'), partial)
  const empty = curlForToken(full, sheetId, two, {})
  check('an empty save_keys object is refused', 'fail' in empty && empty.message.includes('names every key'), empty)
}

// A start that would fail saves no key; a name clash is caught before anything is written.
{
  const t = curlForToken(full, sheetId, "curl https://api.m3.io/x -H 'X-API-Key: m3key1234567890'", true)
  const ok = 'ok' in t ? t.ok : null
  check('m3: prepared', !!ok, t)
  if (ok) {
    const clash = curlStartProblem(uid, sheetId, ok, [{ jsonPath: '$.a', columnName: 'Domain' }], undefined, undefined, false)
    check('an output column that exists stops the start before the save', !!clash && keyValue('m3') === undefined, clash)
    const est = curlStartProblem(uid, sheetId, ok, [{ jsonPath: '$.a', columnName: 'Domain' }], undefined, undefined, true)
    check('an estimate checks only the keys', est === null, est)
  }
  const other = curlForToken(full, sheetId, "curl https://api.hunter.io/v2/x -H 'X-API-Key: another-hunter-key-99'",
    { 'X-API-Key header': 'hunter_io' })
  const conflict = 'ok' in other
    ? curlStartProblem(uid, sheetId, other.ok, [{ jsonPath: '$.a', columnName: 'New col' }], undefined, undefined, false) : null
  check('a key name holding another value is caught by the dry run', !!conflict && conflict.fail === 'conflict'
    && keyValue('hunter_io') === 'hunterkey1234567', conflict)
}

// A bad "Only run if" rule is caught before any key is saved.
{
  const t = curlForToken(full, sheetId, "curl https://api.rule.io/x -H 'X-API-Key: rulekey1234567890'", true)
  const problem = 'ok' in t
    ? curlStartProblem(uid, sheetId, t.ok, [{ jsonPath: '$.a', columnName: 'Rule col' }], undefined,
      '{{Nonexistent}} is not empty', false)
    : null
  check('a bad run_if stops the start before the save', !!problem && keyValue('rule') === undefined, problem)
}

if (failures > 0) { console.error(`\n${failures} curl-import-agents check(s) failed`); process.exit(1) }
console.log('\nall curl-import-agents checks passed')
