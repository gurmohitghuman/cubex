// A hiring table's filters on Companies, pure (lib/hiring/company-filters.ts, input.ts): "at least N matching
// roles" and the companies left out, parsed for the app (camelCase) and for /api/v1 and MCP (snake_case) with the
// exact refusals; they never turn a table into one that searches the job index itself; what the summary keeps off
// (a website as the summary keys it). And the Companies cells that join several Roles cells (lib/hiring/summary.ts
// companyCells) stay within the cell-size rule.
import assert from 'node:assert/strict'

let failures = 0
function ok(label: string, fn: () => void) {
  try { fn(); console.log('ok  ', label) } catch (e) { failures++; console.log('FAIL', label, (e as Error).message) }
}

const { parseCompanyFilters, companyKeep, keptOff, hasCompanyFilters, minRolesRefusal } =
  await import('../../server/src/lib/hiring/company-filters')
const { parseHiringInput } = await import('../../server/src/lib/hiring/input')
const { websitesOf } = await import('../../server/src/lib/hiring/filters')
const { addRole, companyCells, newAcc } = await import('../../server/src/lib/hiring/summary')
const { COMPANY_COLUMNS: C } = await import('../../server/src/lib/hiring/names')
const K = await import('../../server/src/lib/constants')

ok('none sent: every company (1, none left out), and no filters', () => {
  const f = parseCompanyFilters({}, 'camel', [])
  assert.deepEqual(f, { minRoles: 1, leaveOutCompanies: [] })
  assert.equal(hasCompanyFilters(f as never), false)
  assert.equal(companyKeep(f as never), null)
  assert.deepEqual(parseCompanyFilters({ min_roles: null, leave_out_companies: ' , ' }, 'snake', []),
    { minRoles: 1, leaveOutCompanies: [] })
})

ok('a whole number, also as digits; websites made plain, once each, from a list or text with commas or lines', () => {
  assert.deepEqual(parseCompanyFilters({ minRoles: '3', leaveOutCompanies: 'https://www.Ramp.com/careers,\nford.com'
    + ', ramp.com' }, 'camel', []), { minRoles: 3, leaveOutCompanies: ['ramp.com', 'ford.com'] })
  assert.deepEqual(parseCompanyFilters({ min_roles: 100, leave_out_companies: ['acme.io'] }, 'snake', []),
    { minRoles: 100, leaveOutCompanies: ['acme.io'] })
})

ok('refusals name the field as the asker sent it, word for word', () => {
  for (const bad of [0, 101, 1.5, -2, '2.5', 'three', true, [3]]) {
    assert.equal(parseCompanyFilters({ min_roles: bad }, 'snake', []),
      'min_roles must be a whole number from 1 to 100.', String(bad))
  }
  assert.equal(minRolesRefusal('minRoles'), 'minRoles must be a whole number from 1 to 100.')
  assert.equal(parseCompanyFilters({ leaveOutCompanies: ['ramp'] }, 'camel', []),
    'Each company in leaveOutCompanies is its website, such as ramp.com (got "ramp").')
  assert.equal(parseCompanyFilters({ leave_out_companies: 7 }, 'snake', []),
    'leave_out_companies must be a list of websites, such as ["ramp.com"].')
  assert.equal(websitesOf({ site: 'ramp.com' }, 'companies'),
    'companies must be a list of websites, such as ["ramp.com"].')
  assert.equal(parseCompanyFilters({ leave_out_companies: ['ramp.com'] }, 'snake', ['ford.com', 'ramp.com']),
    'ramp.com is in both companies and leave_out_companies: take it out of one.')
})

ok('left out and only these compared as the summary keys a company; a website no company can have refused', () => {
  // Searching only Ramp and keeping it off Companies would pay for every role and list none.
  assert.equal(parseCompanyFilters({ leave_out_companies: ['careers.ramp.com'] }, 'snake', ['ford.com', 'ramp.com']),
    'careers.ramp.com in leave_out_companies is the same company as ramp.com in companies: take it out of one.')
  assert.equal(parseCompanyFilters({ leaveOutCompanies: 'ramp.com' }, 'camel', ['jobs.ramp.com']),
    'ramp.com in leaveOutCompanies is the same company as jobs.ramp.com in companies: take it out of one.')
  assert.deepEqual(parseCompanyFilters({ leave_out_companies: ['careers.ramp.com'] }, 'snake', ['ford.com']),
    { minRoles: 1, leaveOutCompanies: ['careers.ramp.com'] })
  for (const d of ['acme.local', 'intranet.corp', 'shop.invalidtld']) {
    assert.equal(parseCompanyFilters({ leave_out_companies: ['ford.com', d] }, 'snake', []),
      `leave_out_companies can't match ${d} to a company: give the company's website, such as ramp.com.`)
  }
  assert.equal(parseCompanyFilters({ leaveOutCompanies: ['acme.local'] }, 'camel', []),
    "leaveOutCompanies can't match acme.local to a company: give the company's website, such as ramp.com.")
})

ok(`at most ${K.HIRING_MAX_LEFT_OUT} websites left out, counted once each, refused at the first past it`, () => {
  const sites = (n: number) => Array.from({ length: n }, (_, i) => `site${i}.com`)
  const most = parseCompanyFilters({ leave_out_companies: [...sites(200), 'SITE0.com', 'www.site1.com'] }, 'snake', [])
  assert.equal((most as { leaveOutCompanies: string[] }).leaveOutCompanies.length, 200)
  assert.equal(parseCompanyFilters({ leave_out_companies: sites(201) }, 'snake', []),
    'leave_out_companies takes at most 200 companies.')
  // Refused at the 201st: a bad item after it is never read.
  assert.equal(parseCompanyFilters({ leave_out_companies: [...sites(201), 'not a site'] }, 'snake', []),
    'leave_out_companies takes at most 200 companies.')
})

ok('with only these, the search filters stay as sent; on their own they never make a direct search', () => {
  const alone = parseHiringInput({ roles: ['SDR'], minRoles: 2, leaveOutCompanies: 'acme.io' })
  assert.ok(typeof alone !== 'string', String(alone))
  assert.equal(alone.filters, null, 'the routed search, as a table without More filters')
  assert.deepEqual(alone.companyFilters, { minRoles: 2, leaveOutCompanies: ['acme.io'] })
  const both = parseHiringInput({ roles: ['SDR'], companies: 'ramp.com', leaveOutCompanies: 'acme.io' })
  assert.ok(typeof both !== 'string' && both.filters !== null)
  assert.equal(parseHiringInput({ roles: ['SDR'], companies: 'ramp.com', leaveOutCompanies: 'https://ramp.com' }),
    'ramp.com is in both companies and leaveOutCompanies: take it out of one.')
  const plain = parseHiringInput({ roles: ['SDR'] })
  assert.ok(typeof plain !== 'string')
  assert.deepEqual(plain.companyFilters, { minRoles: 1, leaveOutCompanies: [] })
})

ok('what the summary keeps off: too few roles, or a website left out as the summary keys it', () => {
  const keep = companyKeep({ minRoles: 3, leaveOutCompanies: ['careers.ramp.com', 'ford.com'] })!
  assert.deepEqual([...keep.leftOut], ['ramp.com', 'ford.com'])
  assert.equal(keptOff(keep, { count: 2, domain: 'acme.io' }), true, 'under 3')
  assert.equal(keptOff(keep, { count: 3, domain: 'acme.io' }), false)
  assert.equal(keptOff(keep, { count: 9, domain: 'ramp.com' }), true, 'left out')
  assert.equal(keptOff(keep, { count: 9, domain: '' }), false, 'known by name only: kept')
  const onlyLeftOut = companyKeep({ minRoles: 1, leaveOutCompanies: ['ford.com'] })!
  assert.equal(keptOff(onlyLeftOut, { count: 1, domain: 'acme.io' }), false)
})

ok('the cells joining Roles cells stay within the cell-size rule, each one alone as before', () => {
  const max = K.CELL_MAX_ENRICHMENT
  const acc = newAcc('acme.io')
  for (let i = 0; i < 8; i++) {
    addRole(acc, { title: `${i}`.repeat(max), company: 'Acme', posted: '2026-11-20', link: `https://${i}`.padEnd(max,
      'x'), isNew: true })
  }
  const cells = companyCells(acc, { label: '2026-11-23', sinceLabel: '2026-11-16' })
  for (const c of [C.titles, C.links, C.newSince]) {
    assert.ok(cells[c].length <= max, `${c}: ${cells[c].length}`)
    assert.ok(cells[c].length > max - 100, `${c} keeps what fits: ${cells[c].length}`)
  }
  // A short one is written as before.
  const small = newAcc('acme.io')
  addRole(small, { title: 'SDR', company: 'Acme', posted: '2026-11-20', link: 'https://a/1', isNew: true })
  addRole(small, { title: 'BDR', company: 'Acme', posted: '2026-11-21', link: 'https://a/2', isNew: true })
  const plain = companyCells(small, { label: '2026-11-23', sinceLabel: '2026-11-16' })
  assert.deepEqual([plain[C.titles], plain[C.links], plain[C.newSince]],
    ['SDR, BDR', 'https://a/2\nhttps://a/1', 'New since Nov 16: 2 roles (SDR, BDR)'])
})

if (failures) { console.log(`${failures} failed`); process.exit(1) }
console.log('All hiring-company-filters assertions passed.')
