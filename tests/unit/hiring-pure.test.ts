// The hiring table's pure parts (lib/hiring/): which company a role belongs to
// (its domain, else its name made plain) and its batch, a company's roles
// folded into what Companies shows (titles, the newest day, links, what's new
// since the check before), the request parse, the provider's fields, the
// table's name, and a check's most as the dialog shows it.
import assert from 'node:assert/strict'

let failures = 0
function ok(label: string, fn: () => void) {
  try { fn(); console.log('ok  ', label) } catch (e) { failures++; console.log('FAIL', label, (e as Error).message) }
}

const { companyKey, keyBatch, plainCompanyName } = await import('../../server/src/lib/hiring/company-key')
const S = await import('../../server/src/lib/hiring/summary')
const { parseHiringInput } = await import('../../server/src/lib/hiring/input')
const { jobFields } = await import('../../server/src/lib/hiring/job-fields')
const { hiringTableBase, COMPANY_COLUMNS: C, ROLE_COLUMNS } = await import('../../server/src/lib/hiring/names')
const K = await import('../../server/src/lib/constants')
const { moneyUp } = await import('../../server/src/lib/cost-ceiling')
const { moneyUp: shownUp } = await import('../../client/src/lib/enrich-format')

ok('a company name made plain: case, spaces and a trailing Inc, LLC or Ltd', () => {
  for (const n of ['Acme', 'ACME  Inc.', 'Acme, Inc', 'acme llc', 'Acme L.L.C.', 'Acme Ltd.', 'Acme Limited',
    'Acme, Inc., LLC', ' acme incorporated ']) assert.equal(plainCompanyName(n), 'acme', n)
  assert.equal(plainCompanyName('Acme Corp'), 'acme corp')
  assert.equal(plainCompanyName('Incline'), 'incline')
  assert.equal(plainCompanyName('  '), '')
})

ok('the key: the domain made plain first, else the name', () => {
  const d = companyKey('https://www.Acme.com/jobs', 'Whatever')
  assert.deepEqual(d, { key: 'acme.com', domain: 'acme.com', byName: false })
  assert.equal(companyKey('acme.com', '')!.key, 'acme.com')
  assert.deepEqual(companyKey('', 'Acme, Inc.'), { key: 'name:acme', domain: '', byName: true })
  assert.equal(companyKey('', ''), null)
  assert.equal(companyKey('not a domain', '')!, null)
})

const role = (title: string, posted: string, link: string, isNew = false) =>
  ({ title, company: 'Acme', posted, link, isNew })

ok('a company\'s batch: the same on every read, spread out, and a batch split in two keeps each key in one half',
  () => {
    const keys = Array.from({ length: 4_000 }, (_, i) => `c${i}.com`)
    assert.equal(keyBatch('acme.com', 1), 0)
    assert.deepEqual(keys.map(k => keyBatch(k, 3)), keys.map(k => keyBatch(k, 3)))
    const sizes = [0, 1, 2].map(b => keys.filter(k => keyBatch(k, 3) === b).length)
    assert.ok(sizes.every(n => n > 1_200 && n < 1_470), sizes.join())
    for (const k of keys) assert.ok([keyBatch(k, 3), keyBatch(k, 3) + 3].includes(keyBatch(k, 6)), k)
  })

ok('a company folded: count, titles once each (", …" past 5), the newest day, the newest 3 links', () => {
  const a = S.newAcc('acme.com')
  const titles = ['SDR', 'sdr', 'BDR', 'AE', 'SE', 'CSM', 'RevOps', 'VP Sales']
  titles.forEach((t, i) => S.addRole(a, role(t, `2026-11-0${i + 1}T10:00:00Z`, `https://j/${i}`)))
  assert.equal(a.count, 8)
  assert.equal(a.name, 'Acme')
  assert.ok(a.titles.length <= K.HIRING_TITLES_SHOWN + 1)
  const cells = S.companyCells(a, { label: '2026-11-19', sinceLabel: null })
  assert.equal(cells[C.openRoles], '8')
  assert.equal(cells[C.titles], 'SDR, BDR, AE, SE, CSM, …')
  assert.equal(cells[C.newest], '2026-11-08')
  assert.equal(cells[C.links], 'https://j/7\nhttps://j/6\nhttps://j/5')
  assert.equal(cells[C.newSince], '')
  assert.equal(cells[C.newRoles], '')
})

ok('posting days in their many forms, and none', () => {
  assert.equal(S.postedDay('2026-11-13'), '2026-11-13')
  assert.equal(S.postedDay('2026-11-13T23:16:55+00:00'), '2026-11-13')
  assert.equal(S.postedDay('Thu, 12 Nov 2026 10:00:00 GMT'), '2026-11-12')
  assert.equal(S.postedDay('yesterday'), '')
})

ok('the first check names nothing new; a later one names what is new since the check before', () => {
  const a = S.newAcc('acme.com')
  S.addRole(a, role('SDR', '2026-11-10', 'https://j/1'))
  S.addRole(a, role('SDR', '2026-11-18', 'https://j/2', true))
  S.addRole(a, role('BDR', '2026-11-18', 'https://j/3', true))
  assert.equal(S.companyCells(a, { label: '2026-11-19', sinceLabel: null })[C.newRoles], '')
  const later = S.companyCells(a, { label: '2026-11-19', sinceLabel: '2026-11-11' })
  assert.equal(later[C.newSince], 'New since Nov 11: 2 roles (SDR, BDR)')
  assert.equal(later[C.newRoles], '2')
  assert.equal(S.newSinceText(a, '2025-12-30', '2026-01-02'), 'New since Dec 30, 2025: 2 roles (SDR, BDR)')
  const quiet = S.newAcc('b.com')
  S.addRole(quiet, role('SDR', '2026-11-10', 'https://j/9'))
  const q = S.companyCells(quiet, { label: '2026-11-19', sinceLabel: '2026-11-11' })
  assert.equal(q[C.newSince], '')
  assert.equal(q[C.newRoles], '')
})

ok('a company with no roles left shows 0 and nothing else', () => {
  const c = S.companyCells(null, { label: '2026-11-19', sinceLabel: '2026-11-11' })
  assert.deepEqual(c, { [C.openRoles]: '0', [C.titles]: '', [C.newest]: '', [C.links]: '', [C.newSince]: '',
    [C.newRoles]: '' })
})

ok('roles found by name join their company found by domain', () => {
  const byDomain = S.newAcc('acme.com')
  S.addRole(byDomain, role('SDR', '2026-11-10', 'https://j/1'))
  const byName = S.newAcc('')
  S.addRole(byName, role('BDR', '2026-11-12', 'https://j/2', true))
  S.mergeAcc(byDomain, byName)
  assert.equal(byDomain.count, 2)
  assert.equal(byDomain.newCount, 1)
  assert.deepEqual(byDomain.titles, ['SDR', 'BDR'])
  assert.equal(byDomain.newest, '2026-11-12')
  assert.deepEqual(byDomain.links, ['https://j/1', 'https://j/2'])
})

ok('a new company row: its name, domain and First seen with its summary', () => {
  const a = S.newAcc('acme.com')
  S.addRole(a, role('SDR', '2026-11-10', 'https://j/1'))
  const r = S.newCompanyRow(a, { label: '2026-11-19', sinceLabel: null })
  assert.equal(r[C.company], 'Acme')
  assert.equal(r[C.domain], 'acme.com')
  assert.equal(r[C.firstSeen], '2026-11-19')
  assert.equal(r[C.openRoles], '1')
})

ok('the request: roles as a list or lines, once each; the defaults', () => {
  const a = parseHiringInput({ roles: 'SDR\n sdr \n\nBusiness Development Rep' })
  assert.ok(typeof a === 'object')
  assert.deepEqual(a.roles, ['SDR', 'Business Development Rep'])
  assert.equal(a.country, null)
  assert.equal(a.place, null)
  assert.equal(a.postedWithinDays, K.HIRING_DEFAULT_POSTED_DAYS)
  assert.equal(a.perSearch, K.HIRING_DEFAULT_PER_SEARCH)
  const b = parseHiringInput({ roles: ['SDR'], country: 'us', place: ' Texas ', postedWithinDays: null,
    perSearch: 10 })
  assert.ok(typeof b === 'object')
  assert.deepEqual([b.country, b.place, b.postedWithinDays, b.perSearch], ['US', 'Texas', null, 10])
  // Digits sent as text read as the number, as MCP's whole-number options take them.
  const c = parseHiringInput({ roles: ['SDR'], postedWithinDays: ' 14 ', perSearch: '5' })
  assert.ok(typeof c === 'object')
  assert.deepEqual([c.postedWithinDays, c.perSearch], [14, 5])
})

ok('the request: refused plainly when wrong', () => {
  const bad = (v: unknown) => assert.equal(typeof parseHiringInput(v), 'string', JSON.stringify(v))
  bad(null)
  bad({ roles: [] })
  bad({ roles: '  \n ' })
  bad({ roles: 'SDR', country: 'USA' })
  bad({ roles: 'SDR', postedWithinDays: 0 })
  bad({ roles: 'SDR', postedWithinDays: K.HIRING_MAX_POSTED_DAYS + 1 })
  bad({ roles: 'SDR', perSearch: 0 })
  bad({ roles: 'SDR', perSearch: K.ENRICH_LIST_MAX_ITEMS + 1 })
  bad({ roles: 'SDR', perSearch: '1.5' })
  bad({ roles: 'SDR', postedWithinDays: '-3' })
  bad({ roles: 'SDR', perSearch: '' })
  // Each refusal names the option as its asker sends it: the app camelCase, /api/v1 and MCP snake_case.
  assert.equal(parseHiringInput({ roles: 'SDR', perSearch: 0 }), `perSearch must be 1 to ${K.ENRICH_LIST_MAX_ITEMS}.`)
  assert.equal(parseHiringInput({ roles: 'SDR', postedWithinDays: 0 }, 'snake'),
    `posted_within_days must be 1 to ${K.HIRING_MAX_POSTED_DAYS} (or null for any time).`)
  assert.equal(parseHiringInput({ roles: 'SDR', perSearch: '1.5' }, 'snake'),
    `per_search must be 1 to ${K.ENRICH_LIST_MAX_ITEMS}.`)
  bad({ roles: ['x'.repeat(K.HIRING_MAX_ROLE_CHARS + 1)] })
  bad({ roles: Array.from({ length: K.HIRING_MAX_ROLES + 1 }, (_, i) => `Role ${i}`) })
  bad({ roles: 'SDR', place: 'p'.repeat(K.HIRING_MAX_PLACE_CHARS + 1) })
})

ok('each provider\'s fields: unique columns, keyed by the link, then the job id', () => {
  for (const p of ['hirebase', 'jobspipe', 'crustdata', 'theirstack', 'predictleads', 'someone-new', null]) {
    const f = jobFields(p)
    const names = f.fields.map(x => x.columnName)
    assert.equal(new Set(names).size, names.length, String(p))
    assert.ok(names.includes(ROLE_COLUMNS.title) && names.includes(ROLE_COLUMNS.link), String(p))
    assert.equal(f.fields.find(x => x.columnName === ROLE_COLUMNS.link)!.path, f.dedupePath, String(p))
  }
  assert.deepEqual(jobFields('HireBase').dedupeAlso, ['$._id'])
  assert.equal(jobFields('jobspipe').dedupePath, '$.final_url')
  assert.equal(jobFields('someone-new').dedupePath, '$.url')
})

ok('the table\'s name: the roles, cut to fit', () => {
  assert.equal(hiringTableBase(['SDR', 'BDR'], 100), 'Hiring: SDR, BDR')
  assert.equal(hiringTableBase(['<b>SDR</b>'], 100), 'Hiring: bSDR/b')
  const long = hiringTableBase(Array.from({ length: 20 }, (_, i) => `Role number ${i}`), 40)
  assert.ok(Array.from(long).length <= 40 && long.endsWith('…'), long)
})

ok('a most in the check dialog: rounded up, as the server says it', () => {
  assert.equal(shownUp(0.075), '$0.075', 'never $0.07')
  const values = [0, 0.0104, 0.1125, 0.9999, 1, 1.875, 12.345, 0.000001]
  for (let i = 1; i < 20_000; i++) values.push(i / 1e6, i * 0.0375 / 7, i / 997)
  for (const v of values) assert.equal(shownUp(v), moneyUp(v), String(v))
})

if (failures > 0) { console.error(`${failures} hiring-pure assertion(s) failed`); process.exit(1) }
console.log('All hiring-pure assertions passed.')
