// A hiring table's search with a Role title cell that has no word to search for (lib/hiring/title-words.ts): only
// punctuation (","), or in the search with More filters only words to leave out ("-intern"), is skipped as an
// empty title is (missing, so no call and nothing paid) instead of searching any role. A title in any script
// counts. The same tools on another sheet (a title read from another column) send what their cells give, as before.
import assert from 'node:assert/strict'

let failures = 0
function ok(label: string, fn: () => void) {
  try { fn(); console.log('ok  ', label) } catch (e) { failures++; console.log('FAIL', label, (e as Error).message) }
}

const { searchesATitle } = await import('../../server/src/lib/hiring/title-words')
const { buildRequest } = await import('../../server/src/lib/enrich-request')
type Tool = Parameters<typeof buildRequest>[0]

const input = (name: string, type: string) => ({ name, in: 'body' as const, type, required: false })
const tool = (id: string, inputs: Tool['inputs']): Tool =>
  ({ id, method: 'POST', identitySets: null, derive: null, queryArrayEncoding: null, inputs })
const direct = tool('hirebase.jobs.search', [input('job_titles', 'array[string]'), input('keywords', 'array[string]')])
const routed = tool('treg.companies.jobs.search', [input('title', 'string'), input('country', 'string')])
const columns = ['Role title', 'Leave out title words', 'Job']
const TITLES = JSON.stringify(['{{Role title}}', '-{{Leave out title words}}'])
const build = (t: Tool, map: Record<string, string>, row: Record<string, string>) =>
  buildRequest(t, map, row, { cleanDomains: false, columns })
const sent = (b: ReturnType<typeof build>) => (b.ok ? JSON.parse(b.body!) : b)

ok('a title has a letter or digit, in any script; with More filters it is not a word to leave out', () => {
  for (const t of ['SDR', 'Account Executive', '営業', 'Développeur', 'C++ dev', 'L2']) {
    assert.ok(searchesATitle(t, true), t)
  }
  for (const t of [',', ' , ', '-', '—', '...', '']) assert.ok(!searchesATitle(t, true), t)
  assert.ok(!searchesATitle('-intern', true))
  assert.ok(searchesATitle('-intern', false), 'the routed search has no words to leave out')
})

ok('the search with More filters: a cell of punctuation or of words to leave out is missing, not "any role"', () => {
  assert.deepEqual(build(direct, { job_titles: TITLES }, { 'Role title': ',' }), { ok: false, missing: 'job_titles' })
  assert.deepEqual(build(direct, { job_titles: TITLES }, { 'Role title': '-intern' }),
    { ok: false, missing: 'job_titles' })
  assert.deepEqual(build(direct, { job_titles: TITLES }, { 'Role title': '', 'Leave out title words': 'intern' }),
    { ok: false, missing: 'job_titles' })
  const row = { 'Role title': ', SDR', 'Leave out title words': 'intern' }
  assert.deepEqual(sent(build(direct, { job_titles: TITLES }, row)), { job_titles: ['SDR', '-intern'] })
})

ok('the routed search: a title of only punctuation is missing', () => {
  assert.deepEqual(build(routed, { title: '{{Role title}}' }, { 'Role title': ' ,. ' }),
    { ok: false, missing: 'title' })
  assert.deepEqual(build(routed, { title: '{{Role title}}' }, {}), { ok: false, missing: 'title' })
  assert.deepEqual(sent(build(routed, { title: '{{Role title}}', country: 'US' }, { 'Role title': 'SDR' })),
    { title: 'SDR', country: 'US' })
})

ok('the same tools on another sheet send what their cells give, as before', () => {
  assert.deepEqual(sent(build(direct, { job_titles: JSON.stringify(['{{Job}}']), keywords: '["ai"]' }, { Job: ',' })),
    { keywords: ['ai'] })
  assert.deepEqual(sent(build(routed, { title: '{{Job}}' }, { Job: ',' })), { title: ',' })
})

if (failures > 0) { console.error(`${failures} hiring-title-words assertion(s) failed`); process.exit(1) }
console.log('All hiring-title-words assertions passed.')
