// treg's catalog writes types two ways (lib/catalog-type.ts): the short words a routed tool had until November
// 2026 (str, int, list…) and the JSON Schema words it has now (string, integer, an array with its items). Both
// read the same: the words; which outputs hold rows; one tool built from either (the job search as captured on
// 2026-11-17 and on 2026-11-20); the stand-in catalog in each (Find companies and People at a company in the new
// words, Perplexity's answer kept in the old); the list planner on them; and request values from the new words.
import fs from 'node:fs'
import typeMod from '../../server/src/lib/catalog-type'
import toolMod from '../../server/src/lib/enrich-tool'
import reqMod from '../../server/src/lib/enrich-request'
import configMod from '../../server/src/lib/enrich-run-config'
import listMod from '../../server/src/services/enrich-list-build'
const { typeWord, isRowList } = typeMod as typeof import('../../server/src/lib/catalog-type')
const { normalizeTool } = toolMod as typeof import('../../server/src/lib/enrich-tool')
const { buildRequest } = reqMod as typeof import('../../server/src/lib/enrich-request')
const { requestToolOf } = configMod as typeof import('../../server/src/lib/enrich-run-config')
const { planListRun, listProviders } = listMod as typeof import('../../server/src/services/enrich-list-build')

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// --- The words -------------------------------------------------------------
const words: [unknown, string | undefined][] = [
  [{ type: 'str' }, 'string'], [{ type: 'string' }, 'string'], [{ type: 'url' }, 'string'],
  [{ type: 'string', format: 'url' }, 'string'], [{ type: 'int' }, 'integer'], [{ type: 'integer' }, 'integer'],
  [{ type: 'float' }, 'number'], [{ type: 'number' }, 'number'], [{ type: 'bool' }, 'boolean'],
  [{ type: 'boolean' }, 'boolean'], [{ type: 'dict' }, 'object'], [{ type: 'object' }, 'object'],
  [{ type: 'text' }, 'text'], [{ type: 'array[string]' }, 'array[string]'],
  [{ type: 'array', items: { type: 'string' } }, 'array[string]'],
  [{ type: 'array', items: { type: 'integer' } }, 'array[integer]'],
  [{ type: 'array', items: { type: ['object', 'string'] } }, 'array[string_or_object]'],
  [{ type: 'list' }, 'array'], [{ type: 'array' }, 'array'],
  [{ type: ['array', 'string'] }, 'string_or_array'], [{ type: ['integer', 'string'] }, 'string_or_integer'],
  [{ type: ['integer', 'number'] }, 'integer'], [{ type: ['str'] }, 'string'],
  [{}, undefined], [null, undefined], [{ type: 3 }, undefined], [{ type: [] }, undefined],
]
for (const [def, want] of words) check(`${JSON.stringify(def)} reads as ${want}`, typeWord(def) === want)

// --- Which outputs hold rows -----------------------------------------------
check('the old word list holds rows', isRowList({ type: 'list' }))
check('an array of objects holds rows', isRowList({ type: 'array', items: { type: 'object' } }))
check('an array whose items may be objects holds rows',
  isRowList({ type: 'array', items: { type: ['object', 'string'] } }))
check('array[object] holds rows', isRowList({ type: 'array[object]' }))
check('an array of text holds none', !isRowList({ type: 'array', items: { type: 'string' } }))
check('an array of numbers holds none', !isRowList({ type: 'array', items: { type: 'integer' } }))
check('an array with no items given holds none', !isRowList({ type: 'array' }))
check('text or a list of text holds none', !isRowList({ type: ['array', 'string'] }))
check('an object holds none', !isRowList({ type: 'object' }))

// --- The job search, as the catalog had it on 2026-11-17 and has it on 2026-11-20 (notes left out) -----------
const jobs = (body: Record<string, unknown>, output: Record<string, unknown>) => normalizeTool({
  endpoint: { id: 'treg.companies.jobs.search', kind: 'routed', method: 'POST', input: { bodyType: 'json', body } },
  routing: { contract: {
    identity: [['domain', 'title'], ['name', 'title'], ['title'], ['name'], ['domain']], derive: {}, output,
  } },
})!
const text = (w: string) => ({ type: w, required: false })
const oldJobs = jobs({
  domain: text('str'), title: text('str'), name: text('str'), country: text('str'), location: text('str'),
  remote: text('bool'), posted_within_days: { type: 'int', required: false, min: 1, max: 365 }, limit: text('int'),
}, { jobs: { type: 'list', required: true }, count: { type: 'int' }, next_cursor: { type: 'str' } })
const newJobs = jobs({
  domain: text('string'), title: text('string'), name: text('string'), country: text('string'),
  location: text('string'), remote: text('boolean'),
  posted_within_days: { type: 'integer', min: 1, max: 365, required: false }, limit: text('integer'),
}, { jobs: { type: 'array', items: { type: 'object' }, required: true }, count: { type: 'integer' },
  next_cursor: { type: 'string' } })
check('old words: the roles are its list', same(oldJobs.list, { field: 'jobs', path: '$.output.jobs' }))
check('new words: the same list', same(newJobs.list, oldJobs.list))
check('the same inputs either way', same(newJobs.inputs, oldJobs.inputs))
check('the same outputs either way', same(newJobs.outputs, oldJobs.outputs))
check('its inputs read as string, boolean and integer', same(newJobs.inputs.map(i => i.type),
  ['string', 'string', 'string', 'string', 'string', 'boolean', 'integer', 'integer']))

// --- The stand-in catalog: the new words, and one tool kept in the old ------------------------------------
const standIn = (id: string) => normalizeTool(JSON.parse(
  fs.readFileSync(`tests/mock-treg/fixtures/catalog/endpoints/${id}.json`, 'utf8')))!
const companies = standIn('treg.companies.search')
const people = standIn('treg.people.search')
check('new words: Find companies returns rows', companies.list?.path === '$.output.companies')
check('new words: People at a company returns rows', people.list?.path === '$.output.people')
check('new words: a list filter is a list of text',
  people.inputs.find(i => i.name === 'keywords')?.type === 'array[string]')
check('new words: an email find returns no rows', standIn('treg.people.email.find').list === null)
check('new words: a single tool\'s array says its items',
  standIn('apollo.people.search').inputs.find(i => i.name === 'person_titles[]')?.type === 'array[string]')
check('old words: Perplexity\'s answer still lists its sources',
  standIn('treg.ai-search.perplexity.answer').list?.field === 'sources')
for (const [name, tool, given] of [['Find companies', companies, ['domain']], ['People at a company', people,
  ['company_domain']], ['Perplexity\'s answer', standIn('treg.ai-search.perplexity.answer'), ['prompt']]] as const) {
  const provider = listProviders(tool, [...given])[0]?.provider
  const plan = provider ? planListRun(tool, { provider, maxItems: 5 }, [...given]) : null
  check(`${name}: the list planner takes it`, !!plan && !('fail' in plan))
}

// --- Request values from the new words ----------------------------------------------------------------------
const single = normalizeTool({ endpoint: { id: 'acme.things.find', kind: 'data', method: 'POST', input: {
  bodyType: 'json', body: {
    ids: { type: 'array', items: { type: 'integer' } }, tags: { type: ['array', 'string'] },
    remote: { type: 'boolean' }, size: { type: ['integer', 'string'] },
  } } } })!
const sent = (row: Record<string, string>) => {
  const b = buildRequest(requestToolOf(single), { ids: '{{I}}', tags: '{{T}}', remote: '{{R}}', size: '{{S}}' }, row,
    { cleanDomains: false, columns: ['I', 'T', 'R', 'S'] })
  return b.ok ? JSON.parse(b.body!) : b
}
check('a list of integers goes as numbers', same(sent({ I: '1, 2', T: 'a', R: 'yes', S: '10' }).ids, [1, 2]))
check('text or a list: a list when written as one',
  same(sent({ I: '1', T: '["a","b"]', R: 'no', S: '1' }).tags, ['a', 'b']))
check('text or a list: text otherwise', sent({ I: '1', T: 'a, b', R: 'no', S: '1' }).tags === 'a, b')
check('a boolean goes as one', sent({ I: '1', T: 'a', R: 'yes', S: '1' }).remote === true)
check('a number or text goes as written', sent({ I: '1', T: 'a', R: 'no', S: '10-50' }).size === '10-50')

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall catalog-type checks passed')
