// Unit test for lib/enrich-errors.ts, lib/enrich-email-status.ts and
// lib/enrich-estimate.ts. Error shapes follow treg's source. Pure.
import errMod from '../../server/src/lib/enrich-errors'
import emailMod from '../../server/src/lib/enrich-email-status'
import estMod from '../../server/src/lib/enrich-estimate'
import fs from 'fs'
const { classifyCall } = errMod as typeof import('../../server/src/lib/enrich-errors')
const { classifyVerify, acceptedBy, statusLabel } = emailMod as typeof import('../../server/src/lib/enrich-email-status')
const { defaultMaxCostPerRow, estimateRun, billsMisses, rowsThatFit } = estMod as typeof import('../../server/src/lib/enrich-estimate')

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}
const ans = (status: number | null, body: unknown, tregError = true, callId: string | null = 'c1', retryAfterSec: number | null = null) =>
  ({ status, body, tregError, callId, retryAfterSec })
const kind = (a: ReturnType<typeof ans>, retries = true) => classifyCall(a, retries)

// --- treg refusals -----------------------------------------------------------
check('2xx is ok', kind(ans(200, {}, false)).kind === 'ok')
check('no response retries (unreachable)', JSON.stringify(kind(ans(null, null, false, null))).includes('unreachable'))
const sat = kind(ans(503, { detail: 'pool saturated', treg_saturated: true }, false, 'c', 2))
check('saturation retries after Retry-After, without X-Treg-Error', sat.kind === 'retry' && sat.afterMs === 2000 && sat.counts === 'saturation')
const bal = kind(ans(402, { detail: { error: 'insufficient_balance', balance_micro: 1200, topup_url: '/app#billing' } }))
check('402 balance pauses', bal.kind === 'pause' && bal.reason === 'balance')
const auto = kind(ans(402, { detail: { error: 'insufficient_balance', autotopup_enabled: true } }))
check('auto top-up wording', auto.kind === 'pause' && auto.message.includes('Auto top-up is on'))
check('402 route_max_cost skips the row', kind(ans(402, { detail: { error: 'route_max_cost' } })).kind === 'row_skip')
check('401 pauses for the key', (k => k.kind === 'pause' && k.reason === 'auth')(kind(ans(401, { detail: 'revoked key' }))))
check('personal token pauses with advice', (k => k.kind === 'pause' && k.message.includes('team API key'))(kind(ans(400, { detail: 'choose an org (send X-Treg-Org)' }))))
check("treg team's cap is its own message", (k => k.kind === 'pause' && k.reason === 'treg_cap' && k.message.includes("isn't Cubex's"))(kind(ans(429, { detail: { error: 'daily_cap_reached' } }))))
check('trial allowance skips the row', kind(ans(429, { detail: { error: 'trial_allowance_reached' } })).kind === 'row_skip')
check('any other treg 429 pauses', kind(ans(429, { detail: 'platform cap unavailable' })).kind === 'pause')
check('capability pinned names the provider', (k => k.kind === 'pause' && k.message.includes('hunter'))(kind(ans(403, { detail: { error: 'capability_pinned', pinned_provider: 'hunter' } }))))
check('authorization required pauses', kind(ans(428, { detail: { error: 'authorization_required' } })).kind === 'pause')
const noCred = kind(ans(404, { detail: 'no apollo credential in this org \u2014 apollo.people.search is a marketplace endpoint\n  connect one: treg connections connect --provider apollo' }))
check('credential missing (plain text) pauses and names the provider', noCred.kind === 'pause' && noCred.message.includes('apollo'))
check('unknown tool fails the run', kind(ans(404, { detail: "unknown endpoint 'x.y'" })).kind === 'fail_run')
check('provider capacity pauses', kind(ans(503, { detail: { error: 'provider_capacity_unavailable', provider: 'apollo' } })).kind === 'pause')
check('bad params fail the row', kind(ans(400, { detail: { error: 'catalog_parameter_invalid', message: 'nope' } })).kind === 'row_fail')
check('no route candidate skips', kind(ans(422, { detail: { error: 'no_route_candidate' } })).kind === 'row_skip')
check('buffer limit fails the row', kind(ans(502, { detail: { error: 'response_buffer_limit' } })).kind === 'row_fail')
check('route failed fails the row', kind(ans(502, { detail: { error: 'route_failed' } })).kind === 'row_fail')
check('lost answer fails the row', kind(ans(410, { detail: { error: 'idempotency_response_lost' } })).kind === 'row_fail')
check('retired tool fails the run', kind(ans(410, { detail: { error: 'catalog_retired' } })).kind === 'fail_run')
check('402 without a known code still pauses for balance', (k => k.kind === 'pause' && k.reason === 'balance')(kind(ans(402, { detail: 'payment required' }))))
check('a tool-policy 403 is not a bad key', (k => k.kind === 'pause' && k.reason === 'team_rule')(kind(ans(403, { detail: 'this token is not allowed to call this tool' }))))
check('a revoked key is a bad key', (k => k.kind === 'pause' && k.reason === 'auth')(kind(ans(403, { detail: 'membership removed or suspended' }))))
check('409 waits on the same key', (k => k.kind === 'retry' && k.counts === 'in_progress')(kind(ans(409, { detail: 'in progress' }))))
check('key reused for another request: new attempt', kind(ans(422, { detail: 'Idempotency-Key reused for a different request' })).kind === 'retry_new_attempt')

// --- Provider errors (relayed, no X-Treg-Error) -----------------------------
check('bare 5xx without call id counts as unreachable', JSON.stringify(kind(ans(500, null, false, null))).includes('unreachable'))
check('provider 429 retries while retries are left', (k => k.kind === 'retry' && k.counts === 'provider')(kind(ans(429, {}, false))))
check('provider 429 fails once retries are used', kind(ans(429, {}, false), false).kind === 'row_fail')
check('provider 404 fails the row', kind(ans(404, { detail: 'not found' }, false)).kind === 'row_fail')
check('provider {error:{message}} text is kept', (k => k.kind === 'row_fail' && k.message.includes('quota exceeded'))(kind(ans(400, { error: { message: 'quota exceeded' } }, false))))

// --- Email verdicts -----------------------------------------------------------
check('valid flag wins', classifyVerify({ valid: true, status: 'deliverable' }).verdict === 'valid')
for (const w of ['accept_all', 'Accept-All', 'accept all', 'acceptall', 'catch_all', 'catch-all', 'catchall', 'Catch-All']) check(`${w} is catch-all`, classifyVerify({ valid: false, status: w }).verdict === 'catch_all')
for (const w of ['risky', 'Risky', 'unknown', 'webmail']) check(`${w} is risky`, classifyVerify({ valid: false, status: w }).verdict === 'risky')
for (const w of ['invalid', 'undeliverable', 'spamtrap', 'brand-new-word']) check(`${w} is invalid`, classifyVerify({ valid: false, status: w }).verdict === 'invalid')
check('no status is no verdict', classifyVerify({ valid: false }).verdict === 'no_verdict')
for (const w of ['timeout', 'error', 'unavailable', 'verifying']) check(`${w} means it couldn't check`, classifyVerify({ valid: false, status: w }).verdict === 'no_verdict')
check('a catch-all is never plain valid', classifyVerify({ valid: true, status: 'accept_all' }).verdict === 'catch_all')
// Words from treg's verifier adapters, and live answers (tests/mock-treg/fixtures/calls).
for (const w of ['valid-risky', 'disposable', 'abuse', 'do_not_mail', 'unverified']) check(`${w} is risky`, classifyVerify({ valid: false, status: w }).verdict === 'risky')
check('a valid word without the flag is valid', classifyVerify({ status: 'deliverable' }).verdict === 'valid' && classifyVerify({ status: 'ok' }).verdict === 'valid')
check('the flag says no: not valid', classifyVerify({ valid: false, status: 'ok' }).verdict !== 'valid')
for (const w of ['risky', 'unknown', 'disposable']) check(`the flag never makes ${w} valid`, classifyVerify({ valid: true, status: w }).verdict === 'risky')
const liveOutput = (name: string) => JSON.parse(fs.readFileSync(`tests/mock-treg/fixtures/calls/${name}.json`, 'utf8')).response.body.output
check('live: Kitt valid-risky is risky', classifyVerify(liveOutput('verify-found')).verdict === 'risky')
check('live: a made-up address is invalid', classifyVerify(liveOutput('verify-nobody')).verdict === 'invalid')
check('safest takes only valid', acceptedBy('safest', 'valid') && !acceptedBy('safest', 'catch_all'))
check('balanced takes catch-all', acceptedBy('balanced', 'catch_all') && !acceptedBy('balanced', 'risky'))
check('wide takes risky, never invalid', acceptedBy('wide', 'risky') && !acceptedBy('wide', 'invalid'))
check('label keeps the provider word', statusLabel('catch_all', 'accept_all') === 'catch-all (accept_all)')
check('label without a different word', statusLabel('valid', 'valid') === 'valid')

// --- Cost guards (cumulative waterfall ceiling) ------------------------------
const prov = (provider: string, usd: number, usdPerHit: number) =>
  ({ endpointId: `${provider}.x`, provider, usd, usdPerHit, hitRate: 0.3, works: 1, accepts: [], exhausted: false })
const waterfall: any = {
  kind: 'waterfall', price: { type: 'per_success', unit: 'call', usd: 0.005, varies: true, overflowUsd: null },
  providers: [prov('quick', 0.005, 0.005), prov('harvest', 0.02, 0.06), prov('pricey', 0.15, 0.15)],
}
check('per_call provider bills misses', billsMisses(waterfall.providers[1]) && !billsMisses(waterfall.providers[0]))
check('default cap = misses + dearest', defaultMaxCostPerRow(waterfall) === 0.17)
check('skipping a provider lowers the cap', defaultMaxCostPerRow(waterfall, { skip: ['pricey'] }) === 0.025)
const mixed: any = { ...waterfall, providers: [prov('cheap', 0.01, 0.01), prov('percall', 0.15, 0.5)] }
check('a per-call provider is counted once', defaultMaxCostPerRow(mixed) === 0.16)
const unobserved: any = { ...waterfall, providers: [prov('new', 0.03, 0.03), { ...prov('fresh', 0.02, 0), usdPerHit: null }] }
check('no observed price per hit: assume it bills misses', defaultMaxCostPerRow(unobserved) === 0.05)
const single: any = { kind: 'single', providers: null, price: { type: 'per_result', unit: 'row', usd: 0.001, varies: false, overflowUsd: null } }
check('per_result cap scales with limit', defaultMaxCostPerRow(single, { limit: 50 }) === 0.05)
check('a $2 single tool keeps its price (no $1 clamp)', defaultMaxCostPerRow({ ...single, price: { ...single.price, type: 'per_call', usd: 2 } }) === 2)
check('overflow price is the worst case', defaultMaxCostPerRow({ ...single, price: { ...single.price, type: 'per_call', usd: 0, overflowUsd: 0.002 } }) === 0.002)
const est = estimateRun(waterfall, 1000, 0.17)
check('estimate low = cheapest', est.lowUsd === 5 && est.highUsd === 170)
check('rows that fit a limit', rowsThatFit(1, 0.5, 0.1) === 5 && rowsThatFit(null, 0, 1) === Infinity && rowsThatFit(1, 1.2, 0.1) === 0)

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall enrich-errors checks passed')
