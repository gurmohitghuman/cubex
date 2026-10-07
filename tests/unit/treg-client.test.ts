// Unit test for lib/treg.ts (key check), lib/treg-catalog.ts (cache) and the
// treg patterns in lib/redact.ts. fetch is stubbed: no network, no DB.
import tregMod from '../../server/src/lib/treg'
import catalogMod from '../../server/src/lib/treg-catalog'
import redactMod from '../../server/src/lib/redact'
const { checkTregKey, classifyKeyRefusal, tregDetail } = tregMod as typeof import('../../server/src/lib/treg')
const { catalogGet, clearCatalogCache } = catalogMod as typeof import('../../server/src/lib/treg-catalog')
const { redactSecrets } = redactMod as typeof import('../../server/src/lib/redact')

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

type Call = { url: string; headers: Record<string, string>; redirect?: string }
let calls: Call[] = []
function stubFetch(answer: (url: string) => { status: number; body?: unknown } | 'throw') {
  calls = []
  ;(globalThis as any).fetch = async (url: string, init: { headers?: Record<string, string>; redirect?: string } = {}) => {
    calls.push({ url, headers: init.headers ?? {}, redirect: init.redirect })
    const a = answer(url)
    if (a === 'throw') throw new TypeError('fetch failed')
    return new Response(a.body === undefined ? '' : JSON.stringify(a.body), { status: a.status })
  }
}

async function main() {
  // --- Refusals in plain words -------------------------------------------
  check('choose an org → personal token', classifyKeyRefusal(400, 'choose an org (send X-Treg-Org)').problem === 'personal_token')
  check('finish team setup → team setup', classifyKeyRefusal(403, 'finish team setup first').problem === 'team_setup')
  check('suspended → suspended', classifyKeyRefusal(403, 'org suspended').problem === 'suspended')
  check('401 → invalid', classifyKeyRefusal(401, 'revoked key').problem === 'invalid')
  check('500 → unknown', classifyKeyRefusal(500, '').problem === 'unknown')
  check('detail string', tregDetail({ detail: 'invalid token' }) === 'invalid token')
  check('detail object message', tregDetail({ detail: { error: 'x', message: 'Nope' } }) === 'Nope')
  check('no detail', tregDetail(null) === '')

  // --- A good key: member check, team, balance ---------------------------
  stubFetch(url => {
    if (url.endsWith('/usage/me')) return { status: 200, body: { org: 'acme', used_today: 3, cap: -1 } }
    if (url.endsWith('/auth/me')) return { status: 200, body: { org: 'acme', org_id: 7 } }
    if (url.includes('/orgs/7/balance')) return { status: 200, body: { balance_micro: 42_100_000, holds: [{ amount_micro: 800_000 }] } }
    return { status: 404 }
  })
  const good = await checkTregKey('treg_abc')
  check('good key is ok', good.ok === true)
  check('team is read', good.ok && good.team === 'acme')
  check('balance is read', good.ok && good.balanceMicro === 42_100_000)
  check('holds are summed', good.ok && good.onHoldMicro === 800_000)
  check('key goes in X-Treg-Token', calls.every(c => c.headers['X-Treg-Token'] === 'treg_abc'))
  check('never an Authorization header', calls.every(c => !Object.keys(c.headers).some(h => h.toLowerCase() === 'authorization')))
  check('client slug is sent', calls.every(c => c.headers['X-Treg-Client'] === 'cubex'))
  check('redirects are refused (the key must not follow one)', calls.every(c => c.redirect === 'error'))

  // --- A personal login token --------------------------------------------
  stubFetch(() => ({ status: 400, body: { detail: 'choose an org (send X-Treg-Org)' } }))
  const personal = await checkTregKey('eyJx')
  check('personal token is explained', !personal.ok && personal.problem === 'personal_token')

  // --- Balance is best-effort --------------------------------------------
  stubFetch(url => (url.includes('/balance') ? { status: 403 } : { status: 200, body: { org: 'acme', org_id: 7 } }))
  const noBalance = await checkTregKey('treg_abc')
  check('valid even without a balance', noBalance.ok && noBalance.balanceMicro === null)

  // --- treg unreachable ----------------------------------------------------
  stubFetch(() => 'throw')
  const down = await checkTregKey('treg_abc')
  check('unreachable is its own problem', !down.ok && down.problem === 'unreachable')

  // --- Catalog cache: one fetch per path, stale on failure, LRU ----------
  clearCatalogCache()
  stubFetch(url => ({ status: 200, body: { url } }))
  await catalogGet('/catalog/search?q=a')
  await catalogGet('/catalog/search?q=a')
  check('cached path fetched once', calls.length === 1)
  const both = await Promise.all([catalogGet('/catalog/search?q=b'), catalogGet('/catalog/search?q=b')])
  check('concurrent reads share one fetch', calls.length === 2 && both.every(r => r.ok))
  check('catalog reads send no key', calls.every(c => !c.headers['X-Treg-Token']))
  for (let i = 0; i < 205; i++) await catalogGet(`/catalog/search?q=lru${i}`)
  calls = []
  await catalogGet('/catalog/search?q=a')
  check('oldest entries are evicted past 200', calls.length === 1)
  check('newest entry is still cached', (await catalogGet('/catalog/search?q=lru204'), calls.length === 1))

  // A failing refresh serves the last good answer, except for a real 404.
  clearCatalogCache()
  stubFetch(() => ({ status: 200, body: { v: 1 } }))
  await catalogGet('/catalog/endpoints/x')
  const realNow = Date.now
  Date.now = () => realNow() + 11 * 60 * 1000 // past the 10-minute TTL
  stubFetch(() => 'throw')
  const stale = await catalogGet<{ v: number }>('/catalog/endpoints/x')
  check('an expired entry answers at once, marked stale', stale.ok && stale.stale === true && stale.body.v === 1)
  await new Promise(r => setTimeout(r, 0))
  check('one background refresh was tried', calls.length === 1)
  stubFetch(() => ({ status: 404, body: { detail: 'unknown endpoint' } }))
  await catalogGet('/catalog/endpoints/x') // still stale; the refresh finds the tool gone
  await new Promise(r => setTimeout(r, 0))
  const gone = await catalogGet('/catalog/endpoints/x')
  check('a tool treg removed drops out', !gone.ok && gone.status === 404)
  Date.now = realNow
  check('a bad tool id never reaches treg', (await (catalogMod as any).getCatalogEndpoint('https://evil.example/x')).ok === false)

  // --- Redaction --------------------------------------------------------------
  const dashKey = 'treg_' + 'A'.repeat(43)
  const signed = 'eyJ1aWQiOiJ1MSIsIm9yZyI6ImFjbWUifQ.' + 'b'.repeat(43)
  check('treg_ key redacted', !redactSecrets(`bad key ${dashKey} here`).includes(dashKey))
  check('signed key redacted', !redactSecrets(`token=${signed}`).includes(signed) && !redactSecrets(`x ${signed} y`).includes('b'.repeat(43)))
  check('echoed X-Treg-Token header redacted', !redactSecrets('X-Treg-Token: mysecretvalue123').includes('mysecretvalue123'))
  check('tool ids are not redacted', redactSecrets('treg.people.email.find failed') === 'treg.people.email.find failed')

  if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
  console.log('\nall treg client checks passed')
}

main().catch(err => { console.error(err); process.exit(1) })
