// The lists a request sends, answered at once however long. A create request's lists are kept once each up to
// their cap (lib/distinct-items.ts): a hiring table's role titles (lib/hiring/input.ts) and six filter lists
// (lib/hiring/filters.ts), and an AI visibility table's questions (lib/ai-visibility/input.ts). Duplicates are
// dropped (case ignored, the first spelling kept; companies by their website), and a list past its cap is refused
// at its first item past it.
// A row read's `columns` (lib/row-select/paths.ts, read_rows and REST rows/query) is capped before it is read, and
// two picks named the same are found with a Set. 50,000 items: the scans these replace took seconds to over 40 s
// on them (they grew with the square of the list), small enough for a revert proof to finish.
import assert from 'node:assert/strict'

let failures = 0
function ok(label: string, fn: () => void) {
  try { fn(); console.log('ok  ', label) } catch (e) { failures++; console.log('FAIL', label, (e as Error).message) }
}

const { DistinctItems } = await import('../../server/src/lib/distinct-items')
const { parseHiringInput } = await import('../../server/src/lib/hiring/input')
const { parseAiVisibilityInput } = await import('../../server/src/lib/ai-visibility/input')
const { parseColumns } = await import('../../server/src/lib/row-select/paths')
const K = await import('../../server/src/lib/constants')
const { MAX_COLUMN_PICKS } = await import('../../server/src/lib/constants-query')

const MANY = 50_000
const FAST_MS = 200
const distinct = (prefix: string) => Array.from({ length: MANY }, (_, i) => `${prefix} ${i}`)
function timed<T>(fn: () => T): { value: T; ms: number } {
  const t = performance.now()
  const value = fn()
  return { value, ms: performance.now() - t }
}

ok('once each, case ignored, the first spelling kept; past the cap nothing is kept', () => {
  const d = new DistinctItems(3)
  for (const s of ['SDR', 'sdr', 'BDR', 'Sdr', 'AE']) assert.equal(d.add(s), true, s)
  assert.deepEqual(d.items, ['SDR', 'BDR', 'AE'])
  assert.equal(d.add('ae'), true, 'a duplicate at the cap is still dropped, not refused')
  assert.equal(d.add('SE'), false)
  assert.deepEqual(d.items, ['SDR', 'BDR', 'AE'])
})

const tooManyRoles = `Start with at most ${K.HIRING_MAX_ROLES} role titles (you can add rows later).`
ok(`role titles: ${MANY.toLocaleString('en-US')} distinct ones are refused at once, as a list or as lines`, () => {
  for (const roles of [distinct('Role'), distinct('Role').join('\n')]) {
    const { value, ms } = timed(() => parseHiringInput({ roles }))
    assert.equal(value, tooManyRoles)
    assert.ok(ms < FAST_MS, `${Math.round(ms)} ms`)
  }
})

ok('role titles: duplicates dropped, the first spelling kept; the cap counts distinct titles', () => {
  const a = parseHiringInput({ roles: ['SDR', ' sdr ', 'BDR', 'SDR'] })
  assert.ok(typeof a === 'object')
  assert.deepEqual(a.roles, ['SDR', 'BDR'])
  const twenty = Array.from({ length: K.HIRING_MAX_ROLES }, (_, i) => `R${i}`)
  const b = parseHiringInput({ roles: [...twenty, ...twenty.map(r => r.toLowerCase())] })
  assert.ok(typeof b === 'object', String(b))
  assert.deepEqual(b.roles, twenty)
  assert.equal(parseHiringInput({ roles: [...twenty, 'One more'] }), tooManyRoles)
  const same = parseHiringInput({ roles: Array.from({ length: MANY }, () => 'SDR') })
  assert.ok(typeof same === 'object')
  assert.deepEqual(same.roles, ['SDR'])
})

ok(`a hiring table's filter lists: ${MANY.toLocaleString('en-US')} distinct items are refused at once`, () => {
  const words = `takes at most ${K.HIRING_MAX_FILTER_WORDS}`
  const cases: Array<[string, string[], string]> = [
    ['descriptionWords', distinct('word'), `descriptionWords ${words} words.`],
    ['leaveOutDescriptionWords', distinct('word'), `leaveOutDescriptionWords ${words} words.`],
    ['leaveOutTitleWords', distinct('word'), `leaveOutTitleWords ${words} words.`],
    ['seniority', distinct('level'), `seniority ${words} items.`],
    ['employmentTypes', distinct('type'), `employmentTypes ${words} items.`],
    ['companies', Array.from({ length: MANY }, (_, i) => `c${i}.com`),
      `companies takes at most ${K.HIRING_MAX_COMPANIES} companies.`],
  ]
  for (const [field, items, refusal] of cases) {
    const { value, ms } = timed(() => parseHiringInput({ roles: ['SDR'], [field]: items }))
    assert.equal(value, refusal, field)
    assert.ok(ms < FAST_MS, `${field}: ${Math.round(ms)} ms`)
  }
  const kept = parseHiringInput({ roles: ['SDR'], seniority: ['senior', 'Senior', 'SENIOR'],
    descriptionWords: ['Salesforce', 'salesforce'], companies: ['ramp.com', 'RAMP.com'] })
  assert.ok(typeof kept === 'object' && kept.filters, String(kept))
  assert.deepEqual([kept.filters.seniority, kept.filters.descriptionWords, kept.filters.companies],
    [['Senior'], ['Salesforce'], ['ramp.com']], 'duplicates dropped, case ignored, as before')
})

ok('a hiring table\'s companies: the cap counts websites, so two spellings of one site count once', () => {
  const max = K.HIRING_MAX_COMPANIES
  const sites = (n: number) => Array.from({ length: n }, (_, i) => `c${i}.com`)
  const companiesOf = (companies: string[]) => {
    const h = parseHiringInput({ roles: ['SDR'], companies })
    return typeof h === 'string' ? h : h.filters?.companies.length
  }
  assert.equal(companiesOf(sites(26).flatMap(s => [s, `https://www.${s}/`])), 26, '26 sites written two ways')
  assert.equal(companiesOf([...sites(max), 'https://c0.com']), max, 'the cap, and one site again')
  assert.equal(companiesOf(sites(max + 1)), `companies takes at most ${max} companies.`)
})

const tooManyQuestions = `Start with at most ${K.AI_VISIBILITY_MAX_QUESTIONS} questions (you can add rows later).`
ok(`questions: ${MANY.toLocaleString('en-US')} distinct ones are refused at once`, () => {
  const { value, ms } = timed(() => parseAiVisibilityInput({ brand: 'Acme', questions: distinct('Question') }))
  assert.equal(value, tooManyQuestions)
  assert.ok(ms < FAST_MS, `${Math.round(ms)} ms`)
})

ok('questions: duplicates dropped, the first spelling kept; the cap counts distinct questions', () => {
  const a = parseAiVisibilityInput({ brand: 'Acme', questions: ['Best CRM?', ' best crm? ', 'Cheapest CRM?'] })
  assert.ok(typeof a === 'object')
  assert.deepEqual(a.questions, ['Best CRM?', 'Cheapest CRM?'])
  const all = Array.from({ length: K.AI_VISIBILITY_MAX_QUESTIONS }, (_, i) => `Q${i}?`)
  const b = parseAiVisibilityInput({ brand: 'Acme', questions: [...all, ...all] })
  assert.ok(typeof b === 'object', String(b))
  assert.equal(b.questions.length, K.AI_VISIBILITY_MAX_QUESTIONS)
  assert.equal(parseAiVisibilityInput({ brand: 'Acme', questions: [...all, 'One more?'] }), tooManyQuestions)
})

const pick = (i: number) => ({ column: 'Response', path: ['data', i], as: `Value ${i}` })
const tooManyColumns = `columns takes at most ${MAX_COLUMN_PICKS} items.`
// The refusal, else how many were taken: an assertion's diff of a 50,000-item answer would fill the memory.
const refusalOf = (v: ReturnType<typeof parseColumns>) => ('error' in v ? v.error : `${v.names.length} names taken`)
ok(`a read's columns: ${MANY.toLocaleString('en-US')} picks or names are refused at once`, () => {
  for (const columns of [Array.from({ length: MANY }, (_, i) => pick(i)), Array.from({ length: MANY }, () => 'A')]) {
    const { value, ms } = timed(() => parseColumns(columns))
    assert.equal(refusalOf(value), tooManyColumns)
    assert.ok(ms < FAST_MS, `${Math.round(ms)} ms`)
  }
})

ok(`a read's columns: up to ${MAX_COLUMN_PICKS} taken, at least a sheet's columns; two named the same refused`, () => {
  assert.ok(MAX_COLUMN_PICKS >= K.MAX_COLUMNS_PER_SHEET)
  const most = Array.from({ length: MAX_COLUMN_PICKS }, (_, i) => pick(i))
  const all = parseColumns(most)
  assert.ok('picks' in all && all.picks!.length === MAX_COLUMN_PICKS, JSON.stringify(all).slice(0, 200))
  assert.deepEqual(all.names, ['Response'])
  assert.equal(refusalOf(parseColumns([...most, pick(MAX_COLUMN_PICKS)])), tooManyColumns)
  assert.deepEqual(parseColumns([pick(1), 'Name', { column: 'Response', path: ['x'], as: 'Value 1' }]),
    { error: 'Two columns would both be named "Value 1": give one an as.' })
  assert.deepEqual(parseColumns(['Name', 'Name']), { names: ['Name', 'Name'], picks: null }, 'plain names as before')
})

if (failures > 0) { console.error(`${failures} request-list-caps assertion(s) failed`); process.exit(1) }
console.log('All request-list-caps assertions passed.')
