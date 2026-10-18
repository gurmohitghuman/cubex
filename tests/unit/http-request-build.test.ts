// The request an HTTP API column sends for one row (lib/http-request-build.ts,
// lib/http-json-template.ts, lib/http-template-parts.ts): column values
// JSON-escaped inside a JSON body's strings and, in query values, only "&", "#",
// "+" and a lone "%" encoded; saved keys and literal text exactly as written;
// "skip empty values" leaving out query parameters, form pairs, JSON fields and
// array items whose {{column}} came out empty. Runs against a throwaway DB
// (DB_PATH) for the saved-key cases.
import { v4 as uuid } from 'uuid'
import buildMod from '../../server/src/lib/http-request-build'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import cryptoMod from '../../server/src/lib/crypto'
const { buildRequest, redactedRequestConfig, encodeQueryValue } =
  buildMod as typeof import('../../server/src/lib/http-request-build')
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { encrypt } = cryptoMod as typeof import('../../server/src/lib/crypto')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
const uid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
const saveKey = (name: string, value: string) => db.prepare(
  'INSERT INTO api_keys (id, user_id, name, key_type, key_value_encrypted) VALUES (?,?,?,?,?)',
).run(uuid(), uid, name, 'custom', encrypt(value))

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}

type Cfg = {
  url?: string; body?: string; headers?: Record<string, string>; skipEmpty?: boolean; method?: 'GET' | 'POST';
}
const build = (c: Cfg, row: Record<string, string>) => buildRequest(
  { method: c.method ?? 'POST', url: c.url ?? 'https://api.example.com/x', headers: c.headers, body: c.body,
    skipEmpty: c.skipEmpty },
  { rowData: row, userId: 'u', mode: 'live', allowSavedKeys: false, gone: [] },
)
const body = (b: string, row: Record<string, string>, skipEmpty = false, headers?: Record<string, string>) =>
  build({ body: b, skipEmpty, headers }, row).body ?? ''
const url = (u: string, row: Record<string, string>, skipEmpty = false) => build({ url: u, skipEmpty }, row).url
const parses = (s: string) => { try { JSON.parse(s); return true } catch { return false } }

// --- JSON bodies: values are escaped inside strings ---
const tricky = 'Bob "B" O\'Hara\\x\nline two\ttab'
{
  const b = body('{"name": "{{Name}}", "n": 1}', { Name: tricky })
  check('a quote, backslash, newline and tab keep the body valid JSON', parses(b), b)
  check('... and arrive exactly', parses(b) && JSON.parse(b).name === tricky)
}
check('text around a token stays as written', body('{"g": "Hi {{Name}}!"}', { Name: 'Ada' }) === '{"g": "Hi Ada!"}')
check('a token for a whole value goes in as written',
  body('{"n": {{Count}}, "o": {{Obj}}}', { Count: '12', Obj: '{"a":[1,2]}' }) === '{"n": 12, "o": {"a":[1,2]}}')
check('a big number literal is kept exactly (never re-serialized)',
  body('{"id": 12345678901234567890, "x": "{{A}}"}', { A: 'a' }) === '{"id": 12345678901234567890, "x": "a"}')
{
  const pretty = '{\n  "a": "{{A}}",\n  "b": [1, 2.50, true, null]\n}'
  check('spacing and formatting are kept', body(pretty, { A: 'z' }) === pretty.replace('{{A}}', 'z'))
}
check('a token inside a key is escaped too', body('{"{{K}}": 1}', { K: 'a"b' }) === '{"a\\"b": 1}')
check('without skipping, an empty value is sent as ""', body('{"e": "{{E}}"}', { E: '' }) === '{"e": ""}')
check('a /column token in a JSON string resolves', body('{"d": "/domain"}', { domain: 'x.com' }) === '{"d": "x.com"}')
check('an unknown /path in a JSON string is left alone', body('{"p": "/v1/users"}', {}) === '{"p": "/v1/users"}')

// --- Not JSON: substituted as written ---
check('plain text is substituted as before', body('Hello {{Name}}', { Name: 'Bob "B"' }) === 'Hello Bob "B"')
check('a JSON-looking body sent as text/plain is not escaped',
  body('{"a": "{{A}}"}', { A: 'x"y' }, false, { 'Content-Type': 'text/plain' }) === '{"a": "x"y"}')
check('{{{Domain}}} still reads the column inside the outer braces', body('{{{Domain}}}', { Domain: 'x' }) === '{x}')
check('a template that is broken JSON falls back to plain substitution',
  body('{"a": {{A}} {{B}}}', { A: '1', B: '2' }) === '{"a": 1 2}')
{
  const deep = '['.repeat(500) + '"{{A}}"' + ']'.repeat(500)
  check('very deep nesting falls back to plain substitution, no crash',
    body(deep, { A: 'q' }) === deep.replace('{{A}}', 'q'))
}

// --- Skip empty values in JSON ---
check('an empty field is left out',
  body('{"email": "{{Email}}", "domain": "{{Domain}}"}', { Email: '', Domain: 'x.co' }, true) === '{"domain": "x.co"}')
check('the last field left out keeps valid JSON',
  parses(body('{"a": "{{A}}", "b": "{{B}}"}', { A: 'x', B: '' }, true))
  && body('{"a": "{{A}}", "b": "{{B}}"}', { A: 'x', B: '' }, true) === '{"a": "x"}')
check('every field left out gives an empty object',
  body('{"a": "{{A}}", "b": "{{B}}"}', { A: '', B: '  ' }, true) === '{}')
check('two tokens both empty count as empty',
  body('{"n": "{{F}} {{L}}", "k": 1}', { F: '', L: '' }, true) === '{"k": 1}')
check('fixed text with an empty token stays', body('{"n": "Mr. {{L}}"}', { L: '' }, true) === '{"n": "Mr. "}')
check('a field with no token stays even when empty',
  body('{"x": "", "a": "{{A}}"}', { A: '' }, true) === '{"x": ""}')
check('an empty unquoted token is left out', body('{"n": {{N}}, "k": 2}', { N: '' }, true) === '{"k": 2}')
check('array items are left out too', body('{"to": ["{{A}}", "{{B}}", "{{C}}"]}', { A: 'a', B: '', C: 'c' }, true)
  === '{"to": ["a", "c"]}')
check('nested fields are left out, the object stays', body('{"p": {"e": "{{E}}"}, "x": 1}', { E: '' }, true)
  === '{"p": {}, "x": 1}')
{
  const pretty = '{\n  "a": "{{A}}",\n  "b": "{{B}}",\n  "c": "{{C}}"\n}'
  check('pretty JSON keeps its layout when a field is left out',
    body(pretty, { A: '1', B: '', C: '3' }, true) === '{\n  "a": "1",\n  "c": "3"\n}')
}

// --- URLs ---
check('a "+" in a query value arrives as a plus', url('https://a.co/p?email={{E}}&q=1', { E: 'a+b@x.co' })
  === 'https://a.co/p?email=a%2Bb@x.co&q=1')
check('"&" and "#" in a value can\'t split the URL (the URL parser encodes the space)',
  url('https://a.co/p?c={{C}}&x=1', { C: 'AT&T #1' }) === 'https://a.co/p?c=AT%26T %231&x=1')
check('a value already holding %XX escapes keeps them (never encoded twice)',
  url('https://a.co/p?q={{Q}}', { Q: 'hello%20world%2B' }) === 'https://a.co/p?q=hello%20world%2B')
check('a lone % is encoded',
  url('https://a.co/p?d={{D}}', { D: '100% off, 5%x' }) === 'https://a.co/p?d=100%25 off, 5%25x')
check('slashes, colons and "=" in a value stay', url('https://a.co/p?u={{U}}', { U: 'https://x.co/a?b=1' })
  === 'https://a.co/p?u=https://x.co/a?b=1')
check('literal text in a query value stays as written', url('https://a.co/p?path=/v1/users&r=/home', {})
  === 'https://a.co/p?path=/v1/users&r=/home')
check('the encoder alone', encodeQueryValue('a&b#c+d%e%2F') === 'a%26b%23c%2Bd%25e%2F')
check('the path stays as written', url('https://a.co/users/{{Id}}/x', { Id: 'a/b' }) === 'https://a.co/users/a/b/x')
check('a pair with no "=" stays as written', url('https://a.co/p?{{Q}}', { Q: 'a=1&b=2' }) === 'https://a.co/p?a=1&b=2')
check('a column named with "#" isn\'t read as a fragment',
  url('https://a.co/p?r={{# Revenue}}#top', { '# Revenue': '5#m' }) === 'https://a.co/p?r=5%23m#top')
check('literal query text is untouched', url('https://a.co/p?a=1&b=x%20y', {}) === 'https://a.co/p?a=1&b=x%20y')
check('a lone surrogate in a value doesn\'t throw',
  url('https://a.co/p?v={{V}}', { V: 'x' + String.fromCharCode(0xd800) }).startsWith('https://a.co/p?v=x'))
check('without skipping, an empty value is sent as empty', url('https://a.co/p?e={{E}}&d=1', { E: '' })
  === 'https://a.co/p?e=&d=1')
check('skipping leaves an empty parameter out', url('https://a.co/p?e={{E}}&d={{D}}', { E: '', D: 'x.co' }, true)
  === 'https://a.co/p?d=x.co')
check('every parameter left out: no "?"', url('https://a.co/p?e={{E}}#f', { E: '' }, true) === 'https://a.co/p#f')
check('a parameter with no token is kept', url('https://a.co/p?k=&e={{E}}', { E: '' }, true) === 'https://a.co/p?k=')

// --- Form bodies ---
const form = { 'Content-Type': 'application/x-www-form-urlencoded' }
check('form values are encoded', body('a={{A}}&b=2', { A: 'x+y&z' }, false, form) === 'a=x%2By%26z&b=2')
check('form pairs are left out when skipping', body('a={{A}}&b={{B}}', { A: '', B: '1' }, true, form) === 'b=1')

// --- Headers, the unknown {{typo}}, and the record kept of the request ---
check('headers are substituted as written',
  build({ headers: { 'X-Q': '{{A}}' } }, { A: 'a b' }).headers['X-Q'] === 'a b')
let threw = ''
try { body('{"a": "{{Nope}}"}', {}) } catch (e) { threw = (e as Error).message }
check('an unknown {{name}} still stops the request', /doesn't match a column or a saved key/.test(threw), threw)
{
  const cfg = {
    method: 'POST' as const, url: 'https://a.co/p?e={{E}}&q={{Gone}}', body: '{"e": "{{E}}", "n": "{{N}}"}',
    skipEmpty: true, goneColumns: ['Gone'],
  }
  const rec = redactedRequestConfig(cfg, { E: 'a"b', N: '' }, 'u', false)
  check('the record shows what was sent: escaped, encoded, left out',
    rec.body === '{"e": "a\\"b"}' && rec.url === 'https://a.co/p?e=a"b&q=[MISSING: {{Gone}}]', rec)
}

// --- Saved keys go out exactly as saved ---
saveKey('example', 'AbC123xyz%2Bq%2F9%3D%3D')
saveKey('odd', 'a"b+c&d')
{
  const withKeys = (c: Cfg) => buildRequest(
    { method: 'POST', url: c.url ?? 'https://a.co/x', headers: c.headers, body: c.body, skipEmpty: c.skipEmpty },
    { rowData: {}, userId: uid, mode: 'live', allowSavedKeys: true, gone: [] },
  )
  check('a key saved from a pasted cURL query goes out byte for byte',
    withKeys({ url: 'https://a.co/p?api_key={{example}}' }).url === 'https://a.co/p?api_key=AbC123xyz%2Bq%2F9%3D%3D')
  check('a key is never encoded in a query value', withKeys({ url: 'https://a.co/p?k={{odd}}' }).url
    === 'https://a.co/p?k=a"b+c&d')
  check('a key in a JSON string is sent as saved', withKeys({ body: '{"k": "{{odd}}"}' }).body === '{"k": "a"b+c&d"}')
  check('a key in a header is sent as saved', withKeys({ headers: { Authorization: 'Bearer {{example}}' } })
    .headers.Authorization === 'Bearer AbC123xyz%2Bq%2F9%3D%3D')
  const rec = redactedRequestConfig({ method: 'GET', url: 'https://a.co/p?k={{example}}' }, {}, uid, true)
  check('the record names the key, never its value, unencoded', rec.url === 'https://a.co/p?k=[REDACTED:example]')
}

// --- Big bodies stay fast ---
{
  const fields = Array.from({ length: 20_000 }, (_, i) => `"f${i}": "{{A}} and {{B}}"`).join(', ')
  const t = Date.now()
  const out = body(`{${fields}}`, { A: 'x'.repeat(10), B: '' }, true)
  check('a 20,000-field body with 40,000 tokens builds in well under a second',
    Date.now() - t < 1000 && parses(out), Date.now() - t)
}

if (failures > 0) { console.error(`\n${failures} assertion(s) failed.`); process.exit(1) }
console.log('\nhttp request build: all passed')
