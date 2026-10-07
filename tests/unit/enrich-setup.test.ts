// Unit test for what the enrichment drawer's Set up step relies on, server
// side: derived inputs (lib/enrich-accepts.ts), which providers a row can
// reach and what that costs (lib/enrich-estimate.ts), card titles
// (lib/enrich-tool-label.ts) and the estimate request (lib/enrich-estimate-input.ts).
// Pure: no DB, no network.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import acceptsMod from '../../server/src/lib/enrich-accepts'
import estMod from '../../server/src/lib/enrich-estimate'
import labelMod from '../../server/src/lib/enrich-tool-label'
import inputMod from '../../server/src/lib/enrich-estimate-input'
import toolMod from '../../server/src/lib/enrich-tool'
import jobMod from '../../server/src/lib/enrich-job-match'
const { keyAvailable, setAvailable, providerCanAnswer } = acceptsMod as typeof import('../../server/src/lib/enrich-accepts')
const { enabledProviders, defaultMaxCostPerRow, estimateRun, noProviderCanRun } = estMod as typeof import('../../server/src/lib/enrich-estimate')
const { jobMatches } = jobMod as typeof import('../../server/src/lib/enrich-job-match')
const { plainText, jobTitle, toolTitle } = labelMod as typeof import('../../server/src/lib/enrich-tool-label')
const { parseEstimateInput } = inputMod as typeof import('../../server/src/lib/enrich-estimate-input')
const { normalizeTool } = toolMod as typeof import('../../server/src/lib/enrich-tool')

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}
const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures/treg', name), 'utf8'))

// --- Derived inputs ----------------------------------------------------------
const derive = {
  full_name: 'join(first_name, last_name)',
  linkedin_url: 'linkedin_url(linkedin_handle)',
  domain: 'coalesce(email_domain(email), host(website))',
}
const known = new Set(['full_name', 'first_name', 'last_name', 'linkedin_url', 'linkedin_handle', 'domain', 'email', 'website'])
const s = (...k: string[]) => new Set(k)
check('a sent key is available', keyAvailable('domain', s('domain'), derive, known))
check('join needs all its keys', keyAvailable('full_name', s('first_name', 'last_name'), derive, known) && !keyAvailable('full_name', s('first_name'), derive, known))
check('coalesce needs any one key', keyAvailable('domain', s('website'), derive, known) && keyAvailable('domain', s('email'), derive, known))
check('coalesce with none is missing', !keyAvailable('domain', s('full_name'), derive, known))
check('a function named like the key is not a ref', keyAvailable('linkedin_url', s('linkedin_handle'), derive, known) && !keyAvailable('linkedin_url', s(), derive, known))
check('an identity set with a derived key', setAvailable(['domain', 'full_name'], s('website', 'first_name', 'last_name'), derive, known))
check('a provider with no listed identities can answer', providerCanAnswer([], s(), derive, known))
check('a LinkedIn-only provider needs LinkedIn', !providerCanAnswer([['linkedin_url']], s('domain', 'full_name'), derive, known))

// --- Which providers a row reaches, and the costs --------------------------
const find = normalizeTool(fixture('email-find.json'))!
const linkedinOnly = find.providers!.filter(p => p.accepts.every(set => set.length === 1 && set[0] === 'linkedin_url'))
const byName = enabledProviders(find, { given: ['domain', 'full_name'] })
check('name + domain leaves out LinkedIn-only providers', linkedinOnly.length > 0 && linkedinOnly.every(p => !byName.includes(p)))
check('without given, every provider counts', enabledProviders(find).length === find.providers!.length)
check('LinkedIn reaches the LinkedIn providers', linkedinOnly.every(p => enabledProviders(find, { given: ['linkedin_url'] }).includes(p)))
const off = { ...find, providers: find.providers!.map((p, i) => (i === 0 ? { ...p, unavailable: 'async' as const } : i === 1 ? { ...p, exhausted: true } : p)) }
check('async and exhausted children are out', !enabledProviders(off).some(p => p === off.providers[0] || p === off.providers[1]))
const order = [find.providers![2].provider, find.providers![0].provider]
const first = enabledProviders(find, { stopAtFirst: true, order })
check('stop at first: only one provider', first.length === 1)
check('stop at first: the first in the user order', first[0].provider === order[0])
check('stop at first: the cap is that provider alone', defaultMaxCostPerRow(find, { stopAtFirst: true, order }) === first[0].usd)
check('skipping lowers or keeps the cap', defaultMaxCostPerRow(find, { skip: [find.providers![find.providers!.length - 1].provider] }) <= defaultMaxCostPerRow(find))
const est = estimateRun(find, 100, 0.05, { given: ['linkedin_url'] })
check('estimate high = rows × cap', est.highUsd === 5)
check('estimate low ≤ high', est.lowUsd <= est.highUsd)

// No provider left to run: nothing is priced (a run would call no one).
const allOff = { skip: find.providers!.map(p => p.provider) }
check('every provider off: no provider can run', noProviderCanRun(find, allOff))
check('every provider off: cap 0', defaultMaxCostPerRow(find, allOff) === 0)
const none = estimateRun(find, 100, 0.5, allOff)
check('every provider off: estimate 0 to 0, even with a typed cap', none.lowUsd === 0 && none.highUsd === 0)
check('nothing mapped: no provider can run', noProviderCanRun(find, { given: [] }))
check('a waterfall with no listed plan keeps its list price', defaultMaxCostPerRow({ ...find, providers: null }) === find.price.usd)

// --- Popular jobs lead a search for their words ------------------------------
check('"company" finds Company from domain', jobMatches('Company from domain', 'company'))
check('plurals fold: "company" finds Find companies', jobMatches('Find companies', 'company'))
check('a blurb is not matched: "company" skips the phone finder', !jobMatches('Find phone number', 'company'))
check('every word must match', !jobMatches('Verify email', 'work email') && jobMatches('Verified work email', 'work email'))
check('a word can be the start of one', jobMatches('Find phone number', 'pho'))
check('short starts do not match', !jobMatches('Find phone number', 'p'))
check('no words, no match', !jobMatches('Verify email', '  '))

// --- Card titles -------------------------------------------------------------
const EM = String.fromCharCode(0x2014)
check('plain text drops em dashes', !plainText(`Enrich a company by domain ${EM} 80+ datapoints`).includes(EM))
check('plain text keeps the words', plainText(`Enrich a company by domain ${EM} 80+ datapoints`) === 'Enrich a company by domain: 80+ datapoints')
check('job title is the first clause', jobTitle(`Find people by role, company or location ${EM} lead lists`, 'people.search', 'x') === 'Find people by role, company or location')
check('job title falls back to the capability', jobTitle(null, 'people.email.find', 'x') === 'People email find')
check('a Popular title wins', toolTitle({ kind: 'waterfall', name: 'n', capability: 'c', capabilityDescription: 'd' }, 'Verified work email') === 'Verified work email')
check('a single provider is named by its tool', toolTitle({ kind: 'single', name: `Find a business email ${EM} verified`, capability: null, capabilityDescription: null }) === 'Find a business email: verified')

// --- The estimate request ----------------------------------------------------
const good = parseEstimateInput({ toolId: 'treg.people.email.find', rows: 1204, given: ['domain', 'full_name'], skip: ['fiber-ai'], order: [], stopAtFirst: false, maxCostPerRowUsd: null, preset: 'verified_email' })
check('a good request parses', 'ok' in good && good.ok.rows === 1204 && good.ok.preset === 'verified_email')
check('a bad tool id is refused', 'error' in parseEstimateInput({ toolId: '../x', rows: 1 }))
check('fractional rows are refused', 'error' in parseEstimateInput({ toolId: 't.x', rows: 1.5 }))
check('a negative cap is refused', 'error' in parseEstimateInput({ toolId: 't.x', rows: 1, maxCostPerRowUsd: -1 }))
check('odd provider names are refused', 'error' in parseEstimateInput({ toolId: 't.x', rows: 1, skip: ['a b'] }))
check('an unknown preset is refused', 'error' in parseEstimateInput({ toolId: 't.x', rows: 1, preset: 'other' }))
check('missing lists default to empty', 'ok' in parseEstimateInput({ toolId: 't.x', rows: 0 }))
const noGiven = parseEstimateInput({ toolId: 't.x', rows: 1 })
check('no given means do not filter by inputs', 'ok' in noGiven && noGiven.ok.given === null)
const emptyGiven = parseEstimateInput({ toolId: 't.x', rows: 1, given: [] })
check('an empty given means nothing is mapped', 'ok' in emptyGiven && Array.isArray(emptyGiven.ok.given) && emptyGiven.ok.given.length === 0)
check('a bad given is refused', 'error' in parseEstimateInput({ toolId: 't.x', rows: 1, given: 'domain' }))

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall enrich-setup checks passed')
