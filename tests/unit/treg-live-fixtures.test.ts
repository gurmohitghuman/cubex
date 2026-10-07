// Cubex's reading of treg, checked against answers captured live on 2026-10-07
// (tests/mock-treg/fixtures, anonymized): the call classifier on each real
// refusal, the waterfall /access completion, and Set up's provider badges.
// Pure: no network, no DB.
import fs from 'fs'
import errMod from '../../server/src/lib/enrich-errors'
import accessMod from '../../server/src/lib/enrich-access'
import { accessByProvider } from '../../client/src/components/enrich-modal/providers'
const { classifyCall } = errMod as typeof import('../../server/src/lib/enrich-errors')
const { missingProviders, accessRow, withRows } = accessMod as typeof import('../../server/src/lib/enrich-access')

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

const read = (rel: string) => JSON.parse(fs.readFileSync(`tests/mock-treg/fixtures/${rel}`, 'utf8'))
function verdict(name: string) {
  const { status, headers, body } = read(`calls/${name}.json`).response
  return classifyCall({
    status, body, tregError: headers['x-treg-error'] === '1', callId: headers['x-treg-call-id'] ?? null,
    retryAfterSec: headers['retry-after'] ? Number(headers['retry-after']) : null,
  }, true)
}

// --- Every live refusal lands where the plan says --------------------------------
check('401 on /call carries X-Treg-Error and pauses for the key', (v => v.kind === 'pause' && v.reason === 'auth')(verdict('call-bad-key')))
check('402 route_max_cost skips the row', (v => v.kind === 'row_skip' && v.message === 'Over the per-row budget')(verdict('find-402-max-cost')))
check('402 insufficient_balance pauses for the balance', (v => v.kind === 'pause' && v.reason === 'balance')(verdict('single-402-balance')))
check('the balance message names what is left', (v => v.kind === 'pause' && v.message.includes('$0.99 left'))(verdict('single-402-balance')))
check('422 identity_incomplete skips the row', verdict('find-422-identity').kind === 'row_skip')
check('422 for a reused key retries with a new attempt', verdict('find-key-mismatch').kind === 'retry_new_attempt')
check('404 for a tool treg lacks fails the run', verdict('unknown-tool-404').kind === 'fail_run')
check('hub tools are off: 404 fails the run', verdict('hub-verified-email').kind === 'fail_run')
for (const ok of ['find-hit', 'find-replay', 'find-repeat-newkey', 'find-miss-first-only', 'find-capped-miss', 'verify-found', 'people-search', 'single-paid', 'single-free']) {
  check(`${ok} is an answer`, verdict(ok).kind === 'ok')
}
const replay = read('calls/find-replay.json').response.headers
check('a replay costs 0 and echoes the first charge', replay['x-treg-cost-micro'] === '0' && replay['x-treg-original-cost-micro'] === '4834' && replay['x-treg-idempotent-replay'] === 'true')
check('a repeat lookup with a new key cost 10% (archive on)', read('calls/find-repeat-newkey.json').response.headers['x-treg-cost-micro'] === '483')
const capped = read('calls/find-capped-miss.json').response
check('a capped miss is a 200 with the capped header', capped.status === 200 && capped.headers['x-treg-route-capped'] === 'true' && capped.body._treg.outcome === 'miss')
const firstOnly = read('calls/find-miss-first-only.json').response
check('a stop-at-first miss still names who was asked (gate Found by on the outcome)', firstOnly.body._treg.served_by !== null && firstOnly.body._treg.outcome === 'miss')
check('a waterfall result is not kept for /calls/{id}/result', read('calls/calls-result.json').response.body.stored === false)

// --- /access: treg plans for the example input only -------------------------------
const liveAccess = read('access/treg.people.email.find.json')
const findTool = read('catalog/endpoints/treg.people.email.find.json')
const providers = findTool.routing.plan.map((p: { endpoint_id: string }) => ({
  provider: p.endpoint_id.split('.')[0], endpointId: p.endpoint_id, unavailable: p.endpoint_id.startsWith('wiza.') ? 'async' : null,
}))
const missing = missingProviders(providers, liveAccess.plan)
// The example input is a LinkedIn URL (treg derives linkedin_handle from it).
check('live plan lists only providers that take a LinkedIn URL', liveAccess.plan.every((r: { identity: string[] }) => r.identity.every(k => k === 'linkedin_url' || k === 'linkedin_handle')))
check('hunter is missing from the live plan and gets asked', missing.some(m => m.provider === 'hunter' && m.endpointId === 'hunter.people.email.find'))
check('a provider in the plan is not asked again', !missing.some(m => m.provider === 'quickenrich'))
check('an async child is never asked', !missing.some(m => m.provider === 'wiza'))
check('one read per provider, not per endpoint', new Set(missing.map(m => m.provider)).size === missing.length)
check('live badges: every provider on treg\'s key, nothing pinned', accessByProvider({ tier: 'routed', metered: null, estimatedCostUsd: null, plan: liveAccess.plan }).size === 0)

const own = accessRow('hunter', 'hunter.people.email.find', { tier: 'credential', metered: false, estimatedCostUsd: null, plan: null })
const billed = accessRow('apollo', 'apollo.people.search', { tier: 'credential', metered: true, estimatedCostUsd: null, plan: null })
const free = accessRow('contactout', 'contactout.people.contact.work', { tier: 'anonymous', metered: false, estimatedCostUsd: 0, plan: null })
const paid = accessRow('tomba', 'tomba.people.email.find', { tier: 'platform', metered: null, estimatedCostUsd: 0.0089, plan: null })
check('a platform row keeps its price', paid?.price_micro === 8900)
check('an unreadable answer adds no row', accessRow('x', 'x.y', null) === null)
const merged = withRows({ tier: 'routed', metered: null, estimatedCostUsd: null, plan: liveAccess.plan }, [own, billed, free, paid, null])
const badges = accessByProvider({ ...merged, plan: merged.plan as Array<Record<string, unknown>> })
check('own key reads as your key', badges.get('hunter') === 'own')
check('a metered connection reads as connected', badges.get('apollo') === 'connected')
check('a free route reads as free', badges.get('contactout') === 'free')
check('treg\'s key has no badge', !badges.has('tomba') && !badges.has('quickenrich'))
check('a routed own-key row (price 0, no metered) reads as your key',
  accessByProvider({ tier: 'routed', metered: null, estimatedCostUsd: null, plan: [{ provider: 'Hunter', tier: 'credential', price_micro: 0 }] }).get('hunter') === 'own')

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall treg live-fixture checks passed')
