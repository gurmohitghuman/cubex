// The Add enrichment drawer's pure helpers (client/src/components/enrich-modal):
// auto-matching inputs to columns, readiness (a mirror of the server's
// lib/enrich-accepts.ts, checked against it here), output defaults and name
// clashes, provider rows, and the card wording. Pure: no DB, no network.
// tsx runs these client modules without Vite's "@/" alias, so a module tested
// here may import from "@/..." only for types (`import type`); value imports
// must be relative (copy.ts and outputs.ts do this).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import toolMod from '../../server/src/lib/enrich-tool'
import acceptsMod from '../../server/src/lib/enrich-accepts'
import { autoMatch, humanize, inputLabel } from '../../client/src/components/enrich-modal/labels'
import { keyAvailable, inputProblem, identityText } from '../../client/src/components/enrich-modal/readiness'
import { defaultOutputs, nameClash, namesProblem, uniqueName } from '../../client/src/components/enrich-modal/outputs'
import { accessByProvider, dropProvider, moveProvider, orderRows, providerRows } from '../../client/src/components/enrich-modal/providers'
import { cardMeta, priceText, providerLine, rateText } from '../../client/src/components/enrich-modal/copy'
import { autoBindings, buildSetup } from '../../client/src/components/enrich-modal/setup-defaults'
import { emptyDraft, pickTool, rowsFor } from '../../client/src/components/enrich-modal/draft'
const { normalizeTool } = toolMod as typeof import('../../server/src/lib/enrich-tool')
const server = acceptsMod as typeof import('../../server/src/lib/enrich-accepts')

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}
const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures/treg', name), 'utf8'))
const find: any = normalizeTool(fixture('email-find.json'))
const person: any = normalizeTool(fixture('enrichlayer-person.json'))

// --- Labels and matching -----------------------------------------------------
check('humanize snake case', humanize('line_type') === 'Line type' && humanize('country_code') === 'Country code')
check('humanize brand words', humanize('linkedin_url') === 'LinkedIn URL')
check('domain reads as company domain', inputLabel('domain', 'people.email.find') === 'Company domain')
check('name in a company job is the company name', inputLabel('name', 'companies.enrich') === 'Company name')
const cols = ['Name', 'Website', 'Email status', 'LinkedIn', 'Company']
check('Website matches domain', autoMatch('domain', 'people.email.find', cols, new Set()) === 'Website')
check('Name matches full_name', autoMatch('full_name', 'people.email.find', cols, new Set()) === 'Name')
check('Email status is never Email', autoMatch('email', 'people.email.verify', cols, new Set()) === null)
check('a taken column is skipped', autoMatch('domain', null, cols, new Set(['Website'])) === null)
check('company name prefers Company over Name', autoMatch('name', 'companies.enrich', cols, new Set()) === 'Company')
check('camelCase inputs match too', autoMatch('fullName', null, cols, new Set()) === 'Name')
check('a provider LinkedIn URL param matches LinkedIn', autoMatch('linkedinStandardProfileURL', null, cols, new Set()) === 'LinkedIn')
check('camelCase reads as words', humanize('fullName') === 'Full name' && humanize('validSMTP') === 'Valid SMTP')
check('company output name is Company name', inputLabel('name', 'companies.enrich') === 'Company name')

// --- Readiness agrees with the server ----------------------------------------
const known = new Set<string>(find.inputs.map((i: any) => i.name))
const cases: string[][] = [[], ['domain'], ['first_name', 'last_name'], ['full_name'], ['linkedin_handle'], ['email']]
for (const sent of cases) {
  for (const key of ['full_name', 'first_name', 'linkedin_url', 'domain']) {
    const a = keyAvailable(key, new Set(sent), find.derive, known)
    const b = server.keyAvailable(key, new Set(sent), find.derive, known)
    if (a !== b) check(`client and server agree on ${key} from [${sent}]`, false)
  }
}
check('client and server derive rules agree on the fixture', true)
const coalesce = { domain: 'coalesce(email_domain(email), host(website))' }
check('coalesce agrees', keyAvailable('domain', new Set(['website']), coalesce, new Set(['domain', 'email', 'website']))
  === server.keyAvailable('domain', new Set(['website']), coalesce, new Set(['domain', 'email', 'website'])))
check('nothing mapped asks for an identity', inputProblem(find, {}, cols)?.startsWith('Pick columns for') === true)
check('name + domain is enough', inputProblem(find, { full_name: { kind: 'column', column: 'Name' }, domain: { kind: 'column', column: 'Website' } }, cols) === null)
check('a deleted column is named', inputProblem(find, { domain: { kind: 'column', column: 'Gone' } }, cols)?.includes('"Gone"') === true)
check('a blank fixed value does not count', inputProblem(find, { linkedin_url: { kind: 'fixed', value: '  ' } }, cols) !== null)
check('identity text lists the sets', identityText(find).includes('LinkedIn URL') && identityText(find).includes(', or '))

// --- Outputs and names ---------------------------------------------------------
check('name clash any case', nameClash('website', cols) === 'Website')
check('name clash by /token', nameClash('# Company', cols) === 'Company')
check('unique name counts up', uniqueName('Website', cols) === 'Website 2')
const outs = defaultOutputs(find, undefined, known, cols, 'Find email')
check('required output starts on', outs.find(o => o.key === 'email')?.enabled === true)
check('an output that echoes an input starts off', outs.find(o => o.key === 'first_name')?.enabled === false)
check('Found by is offered, off', outs.find(o => o.key === 'found_by')?.enabled === false)
const preset = defaultOutputs(find, 'verified_email', known, cols, 'Verified work email')
check('preset outputs', preset.map(o => o.key).join() === 'email,email_status,found_by,checked_by')
check('single tools start with nothing picked', defaultOutputs(person, undefined, new Set(), cols, 'P').every(o => !o.enabled))
check('names: a clash', namesProblem('Website', [], cols, null)?.includes('already exists') === true)
check('names: two new columns, one name', namesProblem('A', [{ key: 'x', path: null, label: 'X', enabled: true, columnName: 'a' }], cols, null)?.startsWith('Two new columns') === true)
check('names: no room', namesProblem('A', [{ key: 'x', path: null, label: 'X', enabled: true, columnName: 'B' }], cols, 1)?.includes('room for 1 more column') === true)
check('names: all good', namesProblem('A', outs, cols, 200) === null)
check('names: a quote or backslash is refused', namesProblem('Email\\Work', [], cols, null)?.startsWith("Column names can't contain") === true
  && namesProblem('Say "hi"', [], cols, null)?.startsWith("Column names can't contain") === true)
const nested: any = { ...person, outputs: [
  { field: 'credits.jobCredits', path: '$.credits.jobCredits' }, { field: 'experiences.title', path: '$.experiences[0].title' },
  { field: 'education.title', path: '$.education[0].title' },
] }
const nestedLabels = defaultOutputs(nested, undefined, new Set(), cols, 'P').map(o => o.label)
check('a nested field reads by its own name', nestedLabels[0] === 'Job credits')
check('two fields with one name keep their path', nestedLabels[1] === 'Experiences title' && nestedLabels[2] === 'Education title')

// --- Provider rows ---------------------------------------------------------------
const twin = [...find.providers, { ...find.providers[0], endpointId: `${find.providers[0].provider}.other`, usd: 0.001, hitRate: 0.9 }]
const rows = providerRows(twin, null)
check('one row per provider', rows.length === new Set(find.providers.map((p: any) => p.provider)).size)
check('a provider row takes the cheapest price and best rate', rows[0].usd === 0.001 && rows[0].hitRate === 0.9)
const access = accessByProvider({ tier: 'routed', metered: null, estimatedCostUsd: null, plan: [
  { provider: rows[1].provider, tier: 'credential', price_micro: 0 }, { provider: rows[2].provider, tier: 'anonymous', price_micro: 0 },
] })
check('own key and free route are read from access', access.get(rows[1].provider.toLowerCase()) === 'own' && access.get(rows[2].provider.toLowerCase()) === 'free')
const order = rows.map(r => r.provider)
check('move down', moveProvider(order, order[0], 1)[1] === order[0])
check('move past the end is a no-op', moveProvider(order, order[order.length - 1], 1).join() === order.join())
check('drop onto a later row', dropProvider(order, order[0], order[2]).indexOf(order[0]) === 2)
check('user order first', orderRows(rows, [order[3]])[0].provider === order[3])

// --- Wording -----------------------------------------------------------------------
check('measured hit rate', rateText({ hitRate: 0.383, okRate: 0.99 }) === 'found 38% of the time')
check('else works rate', rateText({ hitRate: null, okRate: 0.874 }) === 'works 87% of the time')
const price = (type: string | null, usd: number | null) => ({ type, unit: 'call', usd, varies: false, overflowUsd: null })
check('free price', priceText(price('free', 0)) === 'free')
check('per success', priceText(price('per_success', 0.005)) === '$0.0050 when found')
check('per call', priceText(price('per_call', 0.0089)) === '$0.0089 per lookup')
check('unknown price with own key', priceText(price('per_call', null), true) === 'billed by your own provider key')
const card: any = { kind: 'waterfall', childCount: 23, addsRows: false, price: price('per_success', 0.004834), observed: { hitRate: null, okRate: 0.87 } }
check('waterfall card meta', cardMeta(card).join(' · ') === '23 providers · from $0.0048 · works 87% of the time')
check('list waterfall picks one provider', cardMeta({ ...card, addsRows: true })[0] === 'pick 1 of 23 providers')
check('a waterfall without a blurb names its platform', cardMeta({ ...card, blurb: '', platformLabel: 'LinkedIn' })[0] === 'LinkedIn')
check('a Popular job does not', cardMeta({ ...card, blurb: 'Finds an email.', platformLabel: 'People' })[0] === '23 providers')
check('provider line', providerLine({ ...rows[0], usd: 0.005, billsMisses: false, hitRate: 0.38 }) === '$0.0050 when found · 38% found')
check('a provider that bills misses says so', providerLine({ ...rows[0], usd: 0.02, billsMisses: true, hitRate: null, works: null }).includes('found or not'))

// --- Set up defaults and the draft ---------------------------------------------------
const pick: any = { id: find.id, title: 'Verified work email', preset: 'verified_email', addsRows: false }
const setup = buildSetup(pick, find, cols)
check('setup maps Name and Website', (setup.bindings?.full_name as any)?.column === 'Name' && (setup.bindings?.domain as any)?.column === 'Website')
check('setup names the column after the job', setup.columnName === 'Verified work email')
check('setup keeps treg order', setup.providerOrder?.[0] === find.providers[0].provider)
const kitt: any = {
  ...find, kind: 'single', identitySets: null, providers: null, capability: 'people.email.find',
  inputs: [
    { name: 'fullName', in: 'body', type: 'string', required: true },
    { name: 'domain', in: 'body', type: 'string', required: true },
    { name: 'realtime', in: 'body', type: 'boolean', required: true, enum: [true] },
    { name: 'customData', in: 'body', type: 'string', required: false },
  ],
}
const kb = autoBindings(kitt, cols)
check('single tool: camelCase name matched', (kb.fullName as any)?.column === 'Name')
check('a required input with one allowed value is set to it', kb.realtime?.kind === 'fixed' && (kb.realtime as any).value === 'true')
check('optional inputs without a match stay unused', kb.customData === undefined)
const search: any = { ...find, capability: 'people.search', inputs: [
  { name: 'q', in: 'body', type: 'str', required: false }, { name: 'company_domain', in: 'body', type: 'str', required: false },
  { name: 'title', in: 'body', type: 'str', required: false }, { name: 'full_name', in: 'body', type: 'str', required: false },
] }
const emptyLinkedIn = autoBindings(find, cols, false, new Set(['Name', 'Website', 'Company']))
check('an empty column is not auto-matched', emptyLinkedIn.linkedin_url === undefined && (emptyLinkedIn.domain as any)?.column === 'Website')
check('unknown fill: every column can match', (autoBindings(find, cols, false, null).linkedin_url as any)?.column === 'LinkedIn')
const lb = autoBindings(search, cols, true)
check('a list job maps the company domain', (lb.company_domain as any)?.column === 'Website')
check("a list job doesn't turn a person into the search", lb.full_name === undefined && lb.title === undefined)
check('run on falls back to all rows when the selection is gone', rowsFor('selected', { all: 12, filter: null, selected: 0 }) === 12)
check('run on keeps the filter while it exists', rowsFor('filter', { all: 12, filter: 4, selected: 0 }) === 4)
const d1 = pickTool(emptyDraft(), pick)
check('picking a tool opens Set up', d1.step === 'setup' && d1.card?.id === find.id)
const kept = pickTool({ ...d1, columnName: 'Mine', step: 'find' }, pick)
check('picking the same tool keeps the setup', kept.columnName === 'Mine' && kept.step === 'setup')
check('picking another tool starts over', pickTool(kept, { ...pick, id: 'other.tool' }).columnName === '')

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall enrich-setup-client checks passed')
