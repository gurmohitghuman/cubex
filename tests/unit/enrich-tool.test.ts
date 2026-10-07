// Unit test for lib/enrich-tool.ts + lib/enrich-tool-io.ts: treg catalog entries
// (real samples saved 2026-10-07 in fixtures/treg) become Cubex enrichment tools.
// Pure: no DB, no network.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import enrichToolMod from '../../server/src/lib/enrich-tool'
import ioMod from '../../server/src/lib/enrich-tool-io'
import jsonpathMod from '../../server/src/lib/jsonpath-extract'
const { normalizeTool, summarizeTool, hiddenReason } = enrichToolMod as typeof import('../../server/src/lib/enrich-tool')
const { pathSegment, exampleOutputs } = ioMod as typeof import('../../server/src/lib/enrich-tool-io')
const { validateHttpJsonPath } = jsonpathMod as typeof import('../../server/src/lib/jsonpath-extract')

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}
const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures/treg', name), 'utf8'))

// --- A waterfall: treg.people.email.find ---------------------------------
const find = normalizeTool(fixture('email-find.json'))!
check('email find normalizes', find !== null)
check('email find is a waterfall', find.kind === 'waterfall')
check('email find is POST', find.method === 'POST')
check('identity sets include name + domain', !!find.identitySets?.some(s => s.includes('domain') && s.includes('full_name')))
check('identity sets include linkedin_url alone', !!find.identitySets?.some(s => s.length === 1 && s[0] === 'linkedin_url'))
check('email output is $.output.email', find.outputs.some(o => o.field === 'email' && o.path === '$.output.email'))
check('verified output is listed', find.outputs.some(o => o.field === 'verified'))
check('email find is not a list', find.list === null)
check('providers come from the plan, in order', !!find.providers && find.providers.length > 0 && find.providers[0].provider === find.providers[0].endpointId.split('.')[0])
check('provider has price and hit rate', find.providers![0].usd !== null && find.providers![0].hitRate !== null)
check('price usd is read', typeof find.price.usd === 'number' && find.price.usd > 0)
check('waterfall needs no own key', find.needsOwnKey === false)
check('body inputs are identity keys, not filters', find.inputs.filter(i => i.in === 'body').every(i => !i.filter))
check('every output path passes the HTTP JSONPath validator', find.outputs.every(o => validateHttpJsonPath(o.path).ok))

// --- A waterfall with three outputs: treg.people.email.verify -------------
const verify = normalizeTool(fixture('email-verify.json'))!
check('verify outputs valid/status/score', ['valid', 'status', 'score'].every(f => verify.outputs.some(o => o.field === f)))
check('verify identity is email', JSON.stringify(verify.identitySets) === JSON.stringify([['email']]))

// --- A single tool with strict query params and an example answer ---------
const person = normalizeTool(fixture('enrichlayer-person.json'))!
check('enrichlayer is a single tool', person.kind === 'single')
check('strict_query is kept', person.strictQuery === true)
check('query params become query inputs', person.inputs.some(i => i.in === 'query' && i.name === 'profile_url'))
check('example leaves become outputs', person.outputs.some(o => o.field === 'first_name' && o.path === '$.first_name'))
check('example output paths validate', person.outputs.every(o => validateHttpJsonPath(o.path).ok))
check('single tools have no provider list', person.providers === null)

// --- What a row lookup can't use -----------------------------------------
check('async is hidden', hiddenReason({ async: { poll: 'x' } }) !== null)
check('retired is hidden', hiddenReason({ status: 'retired' }) !== null)
check('superseded is hidden', hiddenReason({ superseded_by: 'other.id' }) !== null)
for (const kind of ['action', 'account', 'utility', 'hub']) check(`kind ${kind} is hidden`, hiddenReason({ kind }) !== null)
check('null kind counts as data', hiddenReason({ kind: null }) === null)
check('routed is shown', hiddenReason({ kind: 'routed' }) === null)
check('form body is hidden', hiddenReason({ input: { bodyType: 'form' } }) !== null)
check('json body is shown', hiddenReason({ input: { bodyType: 'json' } }) === null)
check('image generation is hidden', hiddenReason({ platform: 'image-gen' }) !== null)

// --- Own key needed -------------------------------------------------------
const base = { id: 'x.y', kind: 'data', cost: { type: 'per_call', usd: 0.01 } }
check('priced and eligible: no own key', summarizeTool(base)!.needsOwnKey === false)
check('platform_eligible false: own key', summarizeTool({ ...base, platform_eligible: false })!.needsOwnKey === true)
check('platform_blocked: own key', summarizeTool({ ...base, platform_blocked: { reason: 'x' } })!.needsOwnKey === true)
check('no price: own key', summarizeTool({ ...base, cost: { type: 'per_call', usd: null } })!.needsOwnKey === true)
check('free without usd: no own key', summarizeTool({ ...base, cost: { type: 'free', usd: null } })!.needsOwnKey === false)
check('overflow price is read', summarizeTool({ ...base, overflow_price_usd: 0.002 })!.price.overflowUsd === 0.002)

// --- Search results summarize ----------------------------------------------
const search = fixture('search-people.json')
const summaries = (search.results as Record<string, unknown>[]).map(r => summarizeTool(r)).filter(Boolean)
check('search results summarize', summaries.length === search.results.length)
const routed = summaries.find(s => s!.kind === 'waterfall')
check('a routed search result counts its providers', !routed || (routed.childCount ?? 0) > 0)
// children_hidden counts other search ROWS treg cut from the page, not more
// providers: people.search has 24 providers and 7 cut rows, so 24, not 31.
const peopleSearch = summaries.find(s => s!.id === 'treg.people.search')!
check('provider count is the waterfall own list, not cut search rows', peopleSearch.childCount === 24)
check('email find counts its 23 providers', find.childCount === 23)
check('capability description is kept', !!peopleSearch.capabilityDescription?.startsWith('Find people by role'))
check('provider display name comes from the row', summaries.find(s => s!.id === 'getleadsio.people.enrich.from_person')?.providerName === 'GetLeads.io')
check('a required contract output is marked', find.outputs.find(o => o.field === 'email')?.required === true)
check('an optional contract output is not', !find.outputs.find(o => o.field === 'confidence')?.required)

// --- Children a sheet run can't use (from the detail's siblings) -----------
const firstChild = find.providers![0].endpointId
const withSiblings = normalizeTool({
  ...fixture('email-find.json'),
  siblings: [{ id: firstChild, async: true, retired: false }, { id: find.providers![1].endpointId, async: false, retired: true }],
})!
check('an async child is unavailable', withSiblings.providers![0].unavailable === 'async')
check('a retired child is unavailable', withSiblings.providers![1].unavailable === 'retired')
check('other children stay available', withSiblings.providers!.slice(2).every(p => p.unavailable === null))
check('no siblings: every child available', find.providers!.every(p => p.unavailable === null))

// --- JSONPath segments ------------------------------------------------------
check('identifier segment', pathSegment('email') === '.email')
check('spaced key is bracket-quoted', pathSegment('first name') === '["first name"]')
check('quotes are escaped', pathSegment('a"b') === '["a\\"b"]')
check('bracket paths validate', validateHttpJsonPath(`$${pathSegment('first name')}${pathSegment('x')}`).ok)
const ex = exampleOutputs({ data: { people: [{ name: 'A', 'job title': 'CEO' }] }, total: 3 })
check('nested example leaf path', ex.outputs.some(o => o.path === '$.data.people[0]["job title"]'))
check('first array of objects is the list', ex.list?.path === '$.data.people')

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall enrich-tool checks passed')
