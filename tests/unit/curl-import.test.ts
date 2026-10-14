// "Paste a cURL command" services against a migrated throwaway DB: the dialog's
// two calls (services/curl-import-app.ts) and the agents' curl + save_keys
// (services/curl-token.ts, in curl-import-agents.test.ts). Checks that keys are saved encrypted and never
// echoed, a key already saved is offered instead of a copy, a retry reuses the
// same key, a clash with a column or another key's name is refused and rolls
// back the whole save, a $VARIABLE resolves to the saved key of that name, and
// a saved key a column shadows is never offered.
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import cryptoMod from '../../server/src/lib/crypto'
import appMod from '../../server/src/services/curl-import-app'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { decrypt, encrypt } = cryptoMod as typeof import('../../server/src/lib/crypto')
const { importCurlForApp } = appMod as typeof import('../../server/src/services/curl-import-app')

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

const keyRows = () => db.prepare(
  'SELECT name, key_value_encrypted, key_type, description FROM api_keys WHERE user_id = ?',
).all(uid) as Array<{ name: string; key_value_encrypted: string; key_type: string; description: string }>
const keyValue = (name: string) => {
  const row = keyRows().find(r => r.name === name)
  return row ? decrypt(row.key_value_encrypted) : undefined
}
const app = (curl: string, keys?: unknown) => importCurlForApp(uid, sheetId, curl, keys)

const SECRET = 'sk-proj-SECRETabcdefghijklmnop123456'
const OPENAI = `curl https://api.openai.com/v1/models -H 'Authorization: Bearer ${SECRET}'`
  + " -H 'Accept: application/json'"

// A command with no keys fills the form straight away.
{
  const r = app("curl 'https://api.example.com/v1/lookup?domain={{Domain}}&limit=5' -H 'Accept: application/json'")
  const ok = 'ok' in r && !r.ok.needsKeys ? r.ok : null
  check('no keys: the request comes back at once', !!ok, r)
  check('no keys: endpoint and query rows split', ok?.request.endpoint === 'https://api.example.com/v1/lookup'
    && JSON.stringify(ok?.request.query)
      === JSON.stringify([{ key: 'domain', value: '{{Domain}}' }, { key: 'limit', value: '5' }]), ok)
  const flag = app("curl 'https://api.example.com/v1/x?pretty'")
  check('a ?flag with no = stays in the URL', 'ok' in flag && !flag.ok.needsKeys && flag.ok.request.query === null
    && flag.ok.request.endpoint === 'https://api.example.com/v1/x?pretty', flag)
}

// A literal key: first the question, with a masked hint only.
{
  const r = app(OPENAI)
  const ok = 'ok' in r && r.ok.needsKeys ? r.ok : null
  check('a key: the reply asks about it', ok?.keys.length === 1 && ok.keys[0].id === 'header:0', r)
  check('a key: suggested name from the host', ok?.keys[0].suggestedName === 'openai', ok?.keys)
  check('a key: hint is masked', ok?.keys[0].hint === 'sk-p…3456', ok?.keys)
  check('a key: the value is never in the reply', !JSON.stringify(r).includes('SECRETabc'))
  check('a key: nothing saved yet', keyRows().length === 0)
}

// Second call: save it.
{
  const r = app(OPENAI, { 'header:0': { save: 'openai' } })
  const ok = 'ok' in r && !r.ok.needsKeys ? r.ok : null
  const auth = ok?.request.headers.find(h => h.key === 'Authorization')?.value
  check('save: the header references the key', auth === 'Bearer {{openai}}', r)
  check('save: reported as saved', JSON.stringify(ok?.savedKeys) === '["openai"]', ok)
  check('save: stored encrypted, value intact', keyValue('openai') === SECRET)
  check('save: never stored in the clear', !keyRows()[0].key_value_encrypted.includes('SECRET'))
  check('save: typed bearer, described', keyRows()[0].key_type === 'bearer'
    && keyRows()[0].description.includes('Authorization header for api.openai.com'), keyRows()[0])
  check('save: the value is never in the reply', !JSON.stringify(r).includes('SECRETabc'))
}

// The same key again: offered as the existing one; a retry reuses it.
{
  const r = app(OPENAI)
  check('again: the saved key is offered', 'ok' in r && r.ok.needsKeys && r.ok.keys[0].existingKey === 'openai'
    && r.ok.keys[0].suggestedName === 'openai_2', r)
  const retry = app(OPENAI, { 'header:0': { save: 'openai' } })
  check('retry: same name + same value reuses the key', 'ok' in retry && keyRows().length === 1, retry)
  const use = app(OPENAI, { 'header:0': { use: 'openai' } })
  check('use: references the saved key', 'ok' in use && !use.ok.needsKeys
    && use.ok.request.headers[0].value === 'Bearer {{openai}}' && use.ok.savedKeys.length === 0, use)
}

// Refusals.
{
  const other = OPENAI.replace(SECRET, 'sk-proj-DIFFERENTabcdefghijklmno9999')
  const taken = app(other, { 'header:0': { save: 'openai' } })
  check('a taken name with another value is refused', 'fail' in taken && taken.fail === 'conflict', taken)
  const caseClash = app(other, { 'header:0': { save: 'OpenAI' } })
  check('a name that differs only in case is refused', 'fail' in caseClash && caseClash.fail === 'conflict', caseClash)
  const column = app(other, { 'header:0': { save: 'company_name' } })
  check('a name a column answers to is refused', 'fail' in column && column.fail === 'conflict'
    && column.message.includes('also a column'), column)
  const both = "curl https://api.acme.io/x -H 'X-API-Key: acmekey123456' -b 'sid=zzz111222'"
  const rolled = app(both, { 'header:0': { save: 'acme_new' }, 'header:1': { save: 'domain' } })
  check('a refused key rolls back the others', 'fail' in rolled && keyValue('acme_new') === undefined, rolled)
  const noKey = app(other, { 'header:0': { use: 'nope' } })
  check('using a key that does not exist is refused', 'fail' in noKey && noKey.fail === 'bad_request', noKey)
  const badShape = app(other, { 'header:0': { keep: true } })
  check('an unknown choice is refused', 'fail' in badShape && badShape.fail === 'bad_request', badShape)
  const nf = importCurlForApp(uid, uuid(), OPENAI, undefined)
  check('another sheet: not found', 'fail' in nf && nf.fail === 'not_found', nf)
  const parse = app('curl -F file=@a.png https://e.com')
  check('a parse refusal is a bad request', 'fail' in parse && parse.message.includes('Forms'), parse)
}

// Keys a command needs but doesn't hold: typed in the dialog.
{
  const cmd = 'curl https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY"'
  const ask = app(cmd)
  check('$VAR: asks for the key, named after it', 'ok' in ask && ask.ok.needsKeys
    && ask.ok.keys[0].kind === 'missing' && ask.ok.keys[0].suggestedName === 'OPENAI_API_KEY'
    && ask.ok.keys[0].placeholder === '$OPENAI_API_KEY', ask)
  const empty = app(cmd, { 'header:0': { save: 'OPENAI_API_KEY' } })
  check('$VAR: saving needs the pasted key', 'fail' in empty && empty.message.includes('Paste the key'), empty)
  const saved = app(cmd, { 'header:0': { save: 'OPENAI_API_KEY', value: ' sk-typed-in-the-dialog-123 ' } })
  check('$VAR: the typed key is saved, trimmed',
    'ok' in saved && keyValue('OPENAI_API_KEY') === 'sk-typed-in-the-dialog-123', saved)
  const lower = app('curl https://api.openai.com/v1/models -H "Authorization: Bearer $openai_api_key"')
  check('$var: a saved key with another case resolves, with its exact name', 'ok' in lower && !lower.ok.needsKeys
    && lower.ok.request.headers[0].value === 'Bearer {{OPENAI_API_KEY}}', lower)
  const basic = app('curl https://api.twilio.com/x -u $TWILIO_KEY:$TWILIO_SECRET',
    { auth: { save: 'twilio', value: 'AC1:pw2' } })
  check('-u $A:$B: the typed user:password is saved as base64',
    'ok' in basic && keyValue('twilio') === Buffer.from('AC1:pw2').toString('base64')
    && !basic.ok.needsKeys && basic.ok.request.headers[0].value === 'Basic {{twilio}}', basic)
  const sid = app('curl "https://api.twilio.com/Accounts/$TWILIO_SID/Messages.json"')
  check('an unresolved $VAR elsewhere gets a note', 'ok' in sid && !sid.ok.needsKeys
    && sid.ok.notes.some(n => n.includes('{{TWILIO_SID}} (from $TWILIO_SID)')), sid)
}

// A saved key a sheet column shadows (the column would be read) is never offered or used.
{
  db.prepare('INSERT INTO api_keys (id, user_id, name, key_type, key_value_encrypted) VALUES (?,?,?,?,?)')
    .run(uuid(), uid, 'domain', 'api_key', encrypt('shadowed-value-123456'))
  const cmd = "curl https://api.shadow.io/x -H 'X-API-Key: shadowed-value-123456'"
  const r = app(cmd)
  check('a shadowed key is not offered', 'ok' in r && r.ok.needsKeys && r.ok.keys[0].existingKey === undefined, r)
  const use = app(cmd, { 'header:0': { use: 'domain' } })
  check('a shadowed key is refused', 'fail' in use && use.message.includes('also a column'), use)
}

if (failures > 0) { console.error(`\n${failures} curl-import check(s) failed`); process.exit(1) }
console.log('\nall curl-import checks passed')
