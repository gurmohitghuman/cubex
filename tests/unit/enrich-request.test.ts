// Unit test for lib/enrich-request.ts and lib/enrich-input-clean.ts: one row of
// an enrichment becomes a treg request. Pure: no DB, no network.
import reqMod from '../../server/src/lib/enrich-request'
import cleanMod from '../../server/src/lib/enrich-input-clean'
const { buildRequest, fillTemplate, missingInputs, idempotencyKey, requestFingerprint } =
  reqMod as typeof import('../../server/src/lib/enrich-request')
const { cleanDomain, asciiNamePart } = cleanMod as typeof import('../../server/src/lib/enrich-input-clean')

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

// treg.people.email.find shape: POST JSON body, identity sets, derive rules.
const findTool = {
  id: 'treg.people.email.find', method: 'POST', queryArrayEncoding: null,
  identitySets: [['domain', 'full_name'], ['domain', 'first_name', 'last_name'], ['linkedin_url']],
  derive: {
    full_name: 'join(first_name, last_name)', first_name: 'split_first(full_name)', last_name: 'split_last(full_name)',
  },
  inputs: ['domain', 'full_name', 'first_name', 'last_name', 'linkedin_url']
    .map(name => ({ name, in: 'body' as const, type: 'str', required: false })),
}
// Stored rows are sparse: LinkedIn is a column, but this row has no value (no key) for it.
const row: Record<string, string> = {
  Name: 'Patrick Collison', Website: 'https://www.Stripe.com/about', Notes: 'say "hi"',
}
const columns = ['Name', 'Website', 'LinkedIn', 'Notes']
const opts = { cleanDomains: true, columns }

// --- Templates read columns only ------------------------------------------
check('fills a column',
  JSON.stringify(fillTemplate('{{Name}}', row, columns)) === JSON.stringify({ value: 'Patrick Collison' }))
check('column match ignores case', 'value' in fillTemplate('{{website}}', row, columns))
check('unknown column is reported',
  JSON.stringify(fillTemplate('{{Gone}}', row, columns)) === JSON.stringify({ unknown: 'Gone' }))
check('a column the row lacks is an empty cell, not unknown',
  JSON.stringify(fillTemplate('{{LinkedIn}}', row, columns)) === JSON.stringify({ value: '' }))
check('exact name wins over a normalized match',
  JSON.stringify(fillTemplate('{{a.b}}', { 'a.b': 'exact', a_b: 'normalized' }, ['a_b', 'a.b']))
    === JSON.stringify({ value: 'exact' }))
check('literal text passes through',
  JSON.stringify(fillTemplate('fixed', row, columns)) === JSON.stringify({ value: 'fixed' }))

// --- A waterfall body ----------------------------------------------------
const built = buildRequest(findTool, { full_name: '{{Name}}', domain: '{{Website}}' }, row, opts)
check('builds', built.ok)
if (built.ok) {
  check('POST to /call/<tool>', built.method === 'POST' && built.path === '/call/treg.people.email.find')
  check('no query for a JSON tool', built.query === '')
  const body = JSON.parse(built.body!)
  check('domain is cleaned', body.domain === 'stripe.com')
  check('name is sent', body.full_name === 'Patrick Collison')
  check('body keys follow the tool order', Object.keys(body).join(',') === 'domain,full_name')
}
const quoted = buildRequest(findTool, { full_name: '{{Notes}}', domain: '{{Website}}' }, row,
  { cleanDomains: false, columns })
check('quotes in a cell stay valid JSON', quoted.ok && JSON.parse(quoted.body!).full_name === 'say "hi"')
const injected = buildRequest(findTool, { full_name: '","linkedin_url":"evil', domain: 'x.com' }, {},
  { cleanDomains: false, columns })
check('a cell cannot add JSON fields', injected.ok && Object.keys(JSON.parse(injected.body!)).length === 2)

// --- Identity sets and derive ---------------------------------------------
check('first + last derive full_name', missingInputs(findTool, new Set(['domain', 'first_name', 'last_name'])) === null)
check('LinkedIn alone is enough', missingInputs(findTool, new Set(['linkedin_url'])) === null)
check('name without domain is missing', missingInputs(findTool, new Set(['full_name'])) !== null)
const empty = buildRequest(findTool, { linkedin_url: '{{LinkedIn}}' }, row, opts)
check('empty inputs skip the row (no call)', !empty.ok && 'missing' in empty)
const gone = buildRequest(findTool, { domain: '{{Deleted}}' }, row, opts)
check('a deleted column fails clearly', !gone.ok && 'invalid' in gone)

// --- A GET tool with typed query params -----------------------------------
const getTool = {
  id: 'acme.search', method: 'GET', identitySets: null, derive: null, queryArrayEncoding: 'comma',
  inputs: [
    { name: 'q', in: 'query' as const, type: 'string', required: true },
    { name: 'limit', in: 'query' as const, type: 'integer', required: false, min: 1, max: 100 },
    { name: 'country', in: 'query' as const, type: 'string', required: false, enum: ['US', 'GB'] },
    { name: 'tags', in: 'query' as const, type: 'array[string]', required: false },
    { name: 'id', in: 'path' as const, type: 'string', required: false },
    { name: 'raw', in: 'query' as const, type: 'boolean', required: false },
  ],
}
const g = buildRequest(getTool,
  { q: '{{Name}}', limit: '25', country: 'GB', tags: 'a, b', id: 'x/1', raw: 'yes' }, row, opts)
check('GET builds', g.ok)
if (g.ok) {
  check('no body on GET', g.body === null)
  check('query in declared order, encoded',
    g.query === 'q=Patrick%20Collison&limit=25&country=GB&tags=a%2Cb&id=x%2F1&raw=true')
}
check('required query input', !buildRequest(getTool, {}, row, opts).ok)
const notNum = buildRequest(getTool, { q: 'x', limit: 'ten' }, row, opts)
check('integer is checked', !notNum.ok && 'invalid' in notNum)
const tooBig = buildRequest(getTool, { q: 'x', limit: '500' }, row, opts)
check('max is checked', !tooBig.ok && 'invalid' in tooBig && tooBig.invalid.includes('at most 100'))
const badEnum = buildRequest(getTool, { q: 'x', country: 'FR' }, row, opts)
check('enum is checked', !badEnum.ok && 'invalid' in badEnum)
const repeated = buildRequest({ ...getTool, queryArrayEncoding: null }, { q: 'x', tags: 'a,b' }, row, opts)
check('arrays repeat the key by default', repeated.ok && repeated.query.includes('tags=a&tags=b'))
const jsonArr = buildRequest({ ...getTool, queryArrayEncoding: 'json' }, { q: 'x', tags: '["a","b"]' }, row, opts)
check('json array encoding', jsonArr.ok && jsonArr.query.includes(`tags=${encodeURIComponent('["a","b"]')}`))

// --- Idempotency keys -------------------------------------------------------
const parts = { method: 'POST', path: '/call/t', query: '', body: '{"a":1}' }
const k1 = idempotencyKey('run-1', 3, 'f1', parts)
check('same request, same key', k1 === idempotencyKey('run-1', 3, 'f1', parts))
check('next attempt, new key', k1 !== idempotencyKey('run-1', 3, 'f2', parts))
check('a key is scope, row, attempt and the request', k1.startsWith('cbx1:run-1:3:f1:'))
const ak = idempotencyKey('a:entry-1', 'row-id', 't1', parts)
check('an auto-run key keeps its row id, under 200 characters',
  ak.startsWith('cbx1:a:entry-1:row-id:t1:') && ak.length < 200)
check('provider skips change the key',
  requestFingerprint(parts) !== requestFingerprint({ ...parts, exclude: ['hunter'] }))
check('an edited cell changes the key', k1 !== idempotencyKey('run-1', 3, 'f1', { ...parts, body: '{"a":2}' }))
check('a rerun changes the key', k1 !== idempotencyKey('run-2', 3, 'f1', parts))
check('key fits treg (200 chars)', k1.length < 200)
check('skip order does not change the key',
  requestFingerprint({ ...parts, exclude: ['a', 'b'] }) === requestFingerprint({ ...parts, exclude: ['b', 'a'] }))
check('provider order does change the key',
  requestFingerprint({ ...parts, prefer: ['a', 'b'] }) !== requestFingerprint({ ...parts, prefer: ['b', 'a'] }))
const unsafe = buildRequest(getTool, { q: 'x', limit: '9007199254740993' }, row, opts)
check('integers must be exact', !unsafe.ok && 'invalid' in unsafe)
const badId = buildRequest({ ...getTool, id: 'https://evil.example/x' }, { q: 'x' }, row, opts)
check('a tool id can never be a URL', !badId.ok && 'invalid' in badId)

// --- Input clean-up --------------------------------------------------------
check('URL to domain', cleanDomain('https://www.Stripe.com/about?x=1#y') === 'stripe.com')
check('email to domain', cleanDomain('pat@stripe.com') === 'stripe.com')
check('port and trailing dot',
  cleanDomain('stripe.com:443.') === 'stripe.com' || cleanDomain('stripe.com.:443') === 'stripe.com')
check('bare domain unchanged', cleanDomain('acme.io') === 'acme.io')
check('accents stripped for guesses', asciiNamePart('José María') === 'josemaria')
check('apostrophes dropped', asciiNamePart("O'Brien") === 'obrien')

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall enrich-request checks passed')
