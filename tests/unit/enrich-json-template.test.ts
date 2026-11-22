// An enrichment input whose template is laid out as JSON (lib/enrich-template.ts, lib/enrich-request.ts): each
// string is filled from the row on its own, never spliced into JSON text; in a list, a string reading one column
// stands for each comma item of that cell, its "-" kept once; empty strings, objects and lists are left out, and
// an input left empty isn't sent. A text template ("{{A}}", or text that isn't JSON) is filled as before.
import assert from 'node:assert/strict'

let failures = 0
function ok(label: string, fn: () => void) {
  try { fn(); console.log('ok  ', label) } catch (e) { failures++; console.log('FAIL', label, (e as Error).message) }
}

const { fillJsonTemplate, jsonTemplateOf } = await import('../../server/src/lib/enrich-template')
const { buildRequest } = await import('../../server/src/lib/enrich-request')
type Tool = Parameters<typeof buildRequest>[0]

const columns = ['Role', 'Out', 'Country', 'Place', 'Words', 'Days']
const fill = (template: string, row: Record<string, string>) => {
  const t = jsonTemplateOf(template)
  assert.ok(t, template)
  return fillJsonTemplate(t, row, columns)
}
const TITLES = JSON.stringify(['{{Role}}', '-{{Out}}'])
const GEO = JSON.stringify([{ country: '{{Country}}', city: '{{Place}}' }])

ok('only a JSON list or object with a column in it is a JSON template', () => {
  for (const t of ['{{Role}}', 'x, {{Role}}', '["a"]', '{"a": 1}', '[{{Role}}]', '"{{Role}}"', '[ "{{Role}}" ']) {
    assert.equal(jsonTemplateOf(t), null, t)
  }
  assert.deepEqual(jsonTemplateOf(` ${TITLES} `), ['{{Role}}', '-{{Out}}'])
})

ok('a list: one item per comma item of a cell, the "-" before each once', () => {
  assert.deepEqual(fill(TITLES, { Role: 'SDR', Out: 'intern, -senior, , contract ' }),
    { value: ['SDR', '-intern', '-senior', '-contract'] })
  assert.deepEqual(fill(TITLES, { Role: 'SDR' }), { value: ['SDR'] })
  assert.deepEqual(fill(TITLES, { Role: '', Out: 'intern' }), { value: ['-intern'] })
  assert.deepEqual(fill(TITLES, {}), { value: undefined }, 'nothing to send')
  assert.deepEqual(fill(JSON.stringify(['{{Role}} jobs']), { Role: 'SDR, AE' }), { value: ['SDR jobs', 'AE jobs'] })
  assert.deepEqual(fill(JSON.stringify(['a', '{{Role}}']), {}), { value: ['a'] }, 'text without a column stays')
})

ok('an object: each value filled whole, an empty one left out, an empty object left out', () => {
  assert.deepEqual(fill(GEO, { Country: 'United States', Place: 'Austin, TX' }),
    { value: [{ country: 'United States', city: 'Austin, TX' }] })
  assert.deepEqual(fill(GEO, { Country: 'United States' }), { value: [{ country: 'United States' }] })
  assert.deepEqual(fill(GEO, { Place: 'Texas' }), { value: [{ city: 'Texas' }] })
  assert.deepEqual(fill(GEO, { Country: '  ', Place: '' }), { value: undefined })
  assert.deepEqual(fill(JSON.stringify({ q: '{{Role}} in {{Place}}' }), { Role: 'SDR' }), { value: { q: 'SDR in' } })
})

ok('a cell is sent as written: quotes, backslashes, braces and JSON in it are its text', () => {
  const role = 'He said "hi" \\ {{Out}} ["x"]'
  assert.deepEqual(fill(TITLES, { Role: role, Out: 'a' }), { value: [role, '-a'] })
  assert.deepEqual(fill(GEO, { Country: '{"x": 1}', Place: '[1]' }), { value: [{ country: '{"x": 1}', city: '[1]' }] })
})

ok('a column the sheet lacks is named', () => {
  assert.deepEqual(fill(JSON.stringify(['{{Gone}}']), { Gone: 'x' }), { unknown: 'Gone' })
  assert.deepEqual(fill(JSON.stringify({ a: { b: '{{ Gone }}' } }), {}), { unknown: 'Gone' })
})

const input = (name: string, type: string) => ({ name, in: 'body' as const, type, required: false })
const tool: Tool = {
  id: 'hirebase.jobs.search', method: 'POST', identitySets: null, derive: null, queryArrayEncoding: null,
  inputs: [input('job_titles', 'array[string]'), input('geo_locations', 'array[object]'),
    input('keywords', 'array[string]'), input('note', 'string'), input('filter', 'object'),
    input('days_ago', 'integer'), input('ids', 'array[integer]')],
}
const build = (map: Record<string, string>, row: Record<string, string>) =>
  buildRequest(tool, map, row, { cleanDomains: false, columns })

ok('the request: list inputs sent as filled, empty ones not sent, text and number inputs as before', () => {
  const b = build({ job_titles: TITLES, geo_locations: GEO, keywords: JSON.stringify(['{{Words}}', '-{{Out}}']),
    days_ago: '{{Days}}' }, { Role: 'SDR', Out: 'intern', Country: 'United States', Days: '14' })
  assert.ok(b.ok, JSON.stringify(b))
  assert.deepEqual(JSON.parse(b.body!), { job_titles: ['SDR', '-intern'], geo_locations: [{ country: 'United States' }],
    keywords: ['-intern'], days_ago: 14 })
  const none = build({ job_titles: TITLES, geo_locations: GEO }, {})
  assert.ok(none.ok)
  assert.deepEqual(JSON.parse(none.body!), {})
})

ok('only list and object inputs read a JSON template; anything else is filled as text', () => {
  const b = build({ note: TITLES, ids: JSON.stringify(['{{Days}}']), job_titles: '{{Role}}' },
    { Role: 'SDR, AE', Days: '3' })
  assert.ok(b.ok, JSON.stringify(b))
  assert.deepEqual(JSON.parse(b.body!), { note: '["SDR, AE","-"]', ids: [3], job_titles: ['SDR', 'AE'] })
  const obj = build({ filter: JSON.stringify({ title: '{{Role}}' }) }, { Role: 'SDR' })
  assert.ok(obj.ok)
  assert.deepEqual(JSON.parse(obj.body!), { filter: { title: 'SDR' } })
  assert.deepEqual(build({ filter: JSON.stringify(['{{Role}}']) }, { Role: 'SDR' }),
    { ok: false, invalid: 'filter must be a JSON object.' })
  assert.deepEqual(build({ job_titles: JSON.stringify(['{{Gone}}']) }, {}),
    { ok: false, invalid: 'The column "Gone" isn\'t in this sheet anymore.' })
})

ok('a JSON template\'s value is checked as a typed one is', () => {
  const enumTool: Tool = { ...tool, inputs: [{ ...input('job_types', 'array[string]'), enum: ['Full Time'] }] }
  const b = buildRequest(enumTool, { job_types: JSON.stringify(['{{Role}}']) }, { Role: 'Full Time, Gig' },
    { cleanDomains: false, columns })
  assert.ok(!b.ok && 'invalid' in b && b.invalid.startsWith('job_types must be one of Full Time'), JSON.stringify(b))
})

if (failures > 0) { console.error(`${failures} enrich-json-template assertion(s) failed`); process.exit(1) }
console.log('All enrich-json-template assertions passed.')
