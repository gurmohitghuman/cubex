// A hiring table's description words, seniority, employment type, words to leave out and chosen companies, pure
// (lib/hiring/filters.ts, input.ts, search-input.ts, services/job-count.ts directCountBody): the parse for the app
// (camelCase) and for /api/v1 and MCP (snake_case), the role titles as the job index takes them, the country by
// name, the direct search's run input (each filter from its Searches column), and the count's body.
import assert from 'node:assert/strict'

let failures = 0
function ok(label: string, fn: () => void) {
  try { fn(); console.log('ok  ', label) } catch (e) { failures++; console.log('FAIL', label, (e as Error).message) }
}

const { parseHiringFilters, countryName, directRoleTitle } = await import('../../server/src/lib/hiring/filters')
const { parseHiringInput } = await import('../../server/src/lib/hiring/input')
const { searchInput, searchColumns, DIRECT_RUN_IF } = await import('../../server/src/lib/hiring/search-input')
const { FILTER_COLUMNS: F, SEARCH_COLUMNS: S, HIRING_DIRECT_TOOL_ID } =
  await import('../../server/src/lib/hiring/names')
const { fillJsonTemplate, jsonTemplateOf } = await import('../../server/src/lib/enrich-template')
const K = await import('../../server/src/lib/constants')
// Its pure body only (the unit runner gives this test a database of its own).
const { directCountBody } = await import('../../server/src/services/job-count')

ok('none sent, or all empty: no filters (the table searches as one without them)', () => {
  assert.equal(parseHiringFilters({}, 'camel'), null)
  assert.equal(parseHiringFilters({ descriptionWords: ' , ', seniority: [], companies: null }, 'camel'), null)
})

ok('lists or text with commas or lines, trimmed, once each; levels and types matched loosely', () => {
  const f = parseHiringFilters({
    description_words: 'Salesforce, outbound\nsalesforce, -clearance', leave_out_description_words: ['remote only'],
    leave_out_title_words: ['-Intern', ' contract '], seniority: ['senior', 'ENTRY', 'principal/staff/lead', 'Staff'],
    employment_types: 'full-time, contractor', companies: ['https://www.Ramp.com/careers', 'ford.com', 'ramp.com'],
  }, 'snake')
  assert.deepEqual(f, {
    descriptionWords: ['Salesforce', 'outbound'], leaveOutDescriptionWords: ['remote only', 'clearance'],
    leaveOutTitleWords: ['Intern', 'contract'], seniority: ['Senior', 'Entry-Level', 'Principal / Staff / Lead'],
    employmentTypes: ['Full Time', 'Contract'], companies: ['ramp.com', 'ford.com'],
  })
})

ok('refusals name the field as the asker sent it', () => {
  assert.equal(parseHiringFilters({ seniority: ['Lead dev'] }, 'snake'), 'seniority takes Entry-Level, Junior / '
    + 'Associate, Mid-Level, Senior, Principal / Staff / Lead, Executive (got "Lead dev").')
  assert.equal(parseHiringFilters({ employmentTypes: 'time' }, 'camel'),
    'employmentTypes takes Full Time, Part Time, Contract, Internship (got "time").')
  assert.equal(parseHiringFilters({ companies: 'ramp' }, 'snake'),
    'Each company in companies is its website, such as ramp.com (got "ramp").')
  assert.equal(parseHiringFilters({ description_words: 5 }, 'snake'),
    'description_words must be a list of words, such as ["kubernetes"].')
  assert.equal(parseHiringFilters({ leaveOutTitleWords: ['x'.repeat(K.HIRING_MAX_WORD_CHARS + 1)] }, 'camel'),
    `Each word in leaveOutTitleWords is plain text of at most ${K.HIRING_MAX_WORD_CHARS} characters.`)
  const many = Array.from({ length: K.HIRING_MAX_FILTER_WORDS + 1 }, (_, i) => `w${i}`)
  assert.equal(parseHiringFilters({ leave_out_title_words: many }, 'snake'),
    `leave_out_title_words takes at most ${K.HIRING_MAX_FILTER_WORDS} words.`)
  const half = many.slice(0, K.HIRING_MAX_FILTER_WORDS)
  assert.equal(parseHiringFilters({ descriptionWords: half.map(w => `-${w}x`), leaveOutDescriptionWords: half },
    'camel'), `leaveOutDescriptionWords takes at most ${K.HIRING_MAX_FILTER_WORDS} words.`)
  const sites = Array.from({ length: K.HIRING_MAX_COMPANIES + 1 }, (_, i) => `c${i}.com`)
  assert.equal(parseHiringFilters({ companies: sites }, 'snake'),
    `companies takes at most ${K.HIRING_MAX_COMPANIES} companies.`)
})

ok('with filters, a role title is one title the index can take: commas become spaces, no leading "-"', () => {
  assert.equal(directRoleTitle(' - Engineer,  Backend, '), 'Engineer Backend')
  const a = parseHiringInput({ roles: ['Engineer, Backend', 'engineer backend', 'SDR'], seniority: ['Senior'] })
  assert.ok(typeof a === 'object')
  assert.deepEqual(a.roles, ['Engineer Backend', 'SDR'])
  const b = parseHiringInput({ roles: ['Engineer, Backend'] })
  assert.ok(typeof b === 'object')
  assert.deepEqual([b.roles, b.filters], [['Engineer, Backend'], null], 'without filters, as written')
  assert.equal(parseHiringInput({ roles: ['-'], seniority: ['Senior'] }),
    'Add at least one role title, such as "Sales Development Representative".')
})

ok('the country by name, as the job index takes it; anything else as written', () => {
  assert.deepEqual(['US', 'gb', 'CA', 'United States', ''].map(countryName),
    ['United States', 'United Kingdom', 'Canada', 'United States', ''])
})

ok('the direct search: the job index itself, each filter from its column, rows with no title skipped', () => {
  const s = searchInput(true, 'theirstack', 25, 'roles-sheet')
  assert.equal(s.toolId, HIRING_DIRECT_TOOL_ID)
  assert.equal(s.runIf, DIRECT_RUN_IF)
  assert.equal(s.list!.provider, null)
  assert.equal(s.list!.itemsPath, '$.jobs')
  assert.equal(s.list!.dedupePath, '$.application_link', "hirebase's own fields")
  assert.deepEqual(searchColumns(true).slice(4), Object.values(F))
  const row = { [S.role]: 'SDR', [S.country]: 'United States', [S.place]: 'Texas', [S.days]: '14',
    [F.descriptionWords]: 'Salesforce, -clearance', [F.leaveOutDescriptionWords]: 'remote only',
    [F.leaveOutTitleWords]: 'Intern', [F.seniority]: 'Senior', [F.employmentTypes]: 'Full Time',
    [F.companies]: 'ramp.com, ford.com' }
  const sent = Object.fromEntries(Object.entries(s.inputs).map(([k, b]) => {
    if ('column' in b) return [k, row[b.column]]
    const filled = fillJsonTemplate(jsonTemplateOf(b.value)!, row, searchColumns(true))
    return [k, 'value' in filled ? filled.value : filled]
  }))
  assert.deepEqual(sent, {
    job_titles: ['SDR', '-Intern'], keywords: ['Salesforce', '-clearance', '-remote only'],
    geo_locations: [{ country: 'United States', city: 'Texas' }], days_ago: '14', experience_levels: 'Senior',
    job_types: 'Full Time', company_domains: 'ramp.com, ford.com',
  })
  const routed = searchInput(false, 'hirebase', 25, 'roles-sheet')
  assert.deepEqual([routed.toolId, routed.runIf, routed.list!.provider, routed.list!.itemsPath],
    ['treg.companies.jobs.search', null, 'hirebase', undefined], 'without filters, as before')
})

ok("the count's body: the search's own, seniority too, without page or order, and limit 0", () => {
  assert.deepEqual(directCountBody({ job_titles: ['SDR'], experience_levels: ['Senior'], limit: 25, page: 2,
    sort_by: 'date_posted', sort_order: 'asc', job_types: ['Contract'] }),
  { job_titles: ['SDR'], experience_levels: ['Senior'], job_types: ['Contract'], limit: 0 })
})

if (failures > 0) { console.error(`${failures} hiring-filters assertion(s) failed`); process.exit(1) }
console.log('All hiring-filters assertions passed.')
