// treg's public catalog and /access, from fixtures/catalog (captured live and
// slimmed to what Cubex reads, raw field names kept). Search is a plain word
// match over a fixed set of rows; details exist for the Popular jobs and a few
// single tools.
import { fixture, hasFixture, listFixtures, state } from './state.mjs'
import { refuseKey } from './account.mjs'

const rows = fixture('catalog/search-rows.json')
// Every tool with a details fixture can be found too.
for (const file of listFixtures('catalog/endpoints')) {
  const ep = fixture(`catalog/endpoints/${file}`).endpoint
  if (!rows.some(r => r.id === ep.id)) rows.push({ ...ep, input: { bodyType: ep.input?.bodyType } })
}
const words = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

function search(url) {
  const want = words(url.searchParams.get('q'))
  const limit = Math.min(Number(url.searchParams.get('limit') || 20), 100)
  const hits = rows.filter(r => {
    const hay = words([r.id, r.name, r.summary, r.capability, r.capability_description, r.platform_label].join(' '))
    return want.length > 0 && want.every(w => hay.some(h => h.startsWith(w)))
  })
  const ranked = [...hits.filter(r => r.kind === 'routed'), ...hits.filter(r => r.kind !== 'routed')]
  return { query: url.searchParams.get('q'), count: Math.min(ranked.length, limit), total: ranked.length, results: ranked.slice(0, limit) }
}

const detailPath = (id) => `catalog/endpoints/${id}.json`
const detail = (id) => (hasFixture(detailPath(id)) ? fixture(detailPath(id)) : null)

// The waterfall a child endpoint belongs to, with its plan row, for children
// that have no fixture of their own.
function childRow(id) {
  for (const parent of ['treg.people.email.find', 'treg.people.email.verify', 'treg.people.phone.find', 'treg.people.enrich',
    'treg.companies.enrich', 'treg.people.search', 'treg.companies.search', 'treg.google.serp.organic']) {
    const row = detail(parent)?.routing?.plan?.find(p => p.endpoint_id === id)
    if (row) return row
  }
  return null
}

const tierOf = (provider) => (state.ownKeys.includes(provider) ? 'credential' : state.freeProviders.includes(provider) ? 'anonymous' : 'platform')

// treg's /access for a waterfall plans for the tool's own example input only
// (test_request), so providers that need other inputs are left out, as live.
function waterfallAccess(d) {
  const sent = new Set(Object.keys(d.endpoint.test_request?.body ?? {}))
  const plan = [], dropped = []
  for (const p of d.routing.plan) {
    const accepts = (p.accepts ?? []).find(set => set.every(k => sent.has(k)))
    if (!accepts) { dropped.push({ endpoint_id: p.endpoint_id, why: `needs ${(p.accepts ?? []).map(s => `{${s.join(', ')}}`).join(' | ')}` }); continue }
    const provider = p.endpoint_id.split('.')[0]
    const tier = tierOf(provider)
    const price = tier === 'platform' ? Math.round((p.usd ?? 0) * 1e6) : 0
    plan.push({
      endpoint_id: p.endpoint_id, provider, tier, identity: accepts, price_micro: price,
      expected_cost_per_hit_micro: price, hit_rate: p.hit_rate ?? null, ok_rate: p.works ?? null, p50_ms: 100,
      confidence: p.hit_rate == null ? 'ok_rate' : 'measured', exhausted: false,
    })
  }
  return { tier: 'routed', detail: `routed: ${plan.length} providers callable now`, plan, dropped }
}

function singleAccess(id, d) {
  const ep = d?.endpoint
  const row = ep ? null : childRow(id)
  if (!ep && !row) return { status: 404, body: { detail: `unknown endpoint '${id}'` } }
  const provider = ep?.provider ?? id.split('.')[0]
  if (ep && (ep.platform_blocked || ep.platform_eligible === false) && !state.ownKeys.includes(provider)) {
    return { status: 200, body: { tier: 'none', detail: `no ${provider} credential in this org yet` } }
  }
  const tier = tierOf(provider)
  if (tier === 'credential') return { status: 200, body: { tier, metered: false, detail: `will use this org's ${provider} credential (no tool needed)` } }
  if (tier === 'anonymous') return { status: 200, body: { tier, metered: false, detail: 'no provider key needed', estimated_cost_micro: 0, estimated_cost_usd: 0 } }
  const usd = ep?.cost?.usd ?? row?.usd ?? 0
  return { status: 200, body: { tier, detail: `no key needed: uses treg's ${provider} key`, estimated_cost_micro: Math.round(usd * 1e6), estimated_cost_usd: usd } }
}

export function catalogRoute(req, url) {
  if (req.method !== 'GET') return null
  const p = url.pathname
  if (p === '/catalog/search') return { status: 200, body: search(url) }
  if (p === '/catalog/platforms') return { status: 200, body: fixture('catalog/platforms.json') }
  const access = /^\/catalog\/endpoints\/([^/]+)\/access$/.exec(p)
  if (access) {
    const refused = refuseKey(req)
    if (refused) return refused
    const id = decodeURIComponent(access[1])
    const d = detail(id)
    return d?.endpoint?.kind === 'routed' ? { status: 200, body: waterfallAccess(d) } : singleAccess(id, d)
  }
  const one = /^\/catalog\/endpoints\/([^/]+)$/.exec(p)
  if (one) {
    const d = detail(decodeURIComponent(one[1]))
    return d ? { status: 200, body: d } : { status: 404, body: { detail: `unknown endpoint '${decodeURIComponent(one[1])}'` } }
  }
  return null
}
