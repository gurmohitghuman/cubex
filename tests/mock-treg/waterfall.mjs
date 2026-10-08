// A treg waterfall, simulated from the captured catalog plans: the providers a
// request can reach (their accepted identities), X-Treg-Route-Prefer/-Exclude,
// X-Treg-Route-Waterfall: 0 and the cumulative X-Treg-Route-Max-Cost. Who hits
// and what they answer comes from answers.mjs. Prices are the catalog's, and a
// miss is free (every provider here charges per success), as on live treg.
import { fixture, hasFixture, state } from './state.mjs'
import { providerAnswer } from './answers.mjs'

const micro = (usd) => Math.round((usd ?? 0) * 1e6)
const list = (h) => String(h ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)

// treg derives full_name from first_name + last_name (and splits a full name
// back), and the handle from the URL.
function sentKeys(body) {
  const sent = new Set(Object.entries(body ?? {}).filter(([, v]) => v !== '' && v != null).map(([k]) => k))
  if (sent.has('first_name') && sent.has('last_name')) sent.add('full_name')
  if (sent.has('full_name') && String(body.full_name).trim().includes(' ')) { sent.add('first_name'); sent.add('last_name') }
  if (sent.has('linkedin_url')) sent.add('linkedin_handle')
  return sent
}

export function isWaterfall(toolId) {
  const path = `catalog/endpoints/${toolId}.json`
  return hasFixture(path) && fixture(path).endpoint.kind === 'routed'
}

// The providers this call would try, in order, before the budget is applied.
function candidates(toolId, body, headers) {
  const d = fixture(`catalog/endpoints/${toolId}.json`)
  const async = new Set((d.siblings ?? []).filter(s => s.async).map(s => s.id))
  const sent = sentKeys(body)
  const exclude = new Set(list(headers['x-treg-route-exclude']))
  const prefer = list(headers['x-treg-route-prefer'])
  // planIndex is the provider's place in the full plan, so each provider keeps
  // its own answer whatever is excluded.
  const rows = d.routing.plan
    .map((p, i) => ({ ...p, provider: p.endpoint_id.split('.')[0], planIndex: i, async: async.has(p.endpoint_id) }))
    .filter(p => !exclude.has(p.provider) && (p.accepts ?? []).some(set => set.every(k => sent.has(k))))
  const rank = (r) => { const i = prefer.indexOf(r.provider); return i === -1 ? prefer.length : i }
  const ordered = rows.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map(x => x.r)
  return headers['x-treg-route-waterfall'] === '0' ? ordered.slice(0, 1) : ordered
}

// { status, body, costMicro, servedBy } for one routed call, or a 402/422 refusal.
export function runWaterfall(toolId, body, headers) {
  const maxCost = headers['x-treg-route-max-cost'] !== undefined ? micro(Number(headers['x-treg-route-max-cost'])) : 1_000_000
  const plan = candidates(toolId, body, headers)
  if (plan.length === 0) {
    return { status: 422, refusal: { error: 'no_route_candidate', message: 'no provider in this route can take these inputs' } }
  }
  if (micro(plan[0].usd) > maxCost) {
    return { status: 402, refusal: { error: 'route_max_cost', endpoint_id: toolId, max_cost_micro: maxCost, cheapest_micro: micro(plan[0].usd) } }
  }
  const tried = []
  // The cap is cumulative over what was charged so far (route.py): a provider
  // is skipped once spent plus its price would pass it.
  let spent = 0, capped = false, hit = null
  for (const [n, p] of plan.entries()) {
    const price = micro(p.usd)
    if (spent + price > maxCost) {
      capped = true
      tried.push({ endpoint_id: p.endpoint_id, provider: p.provider, outcome: 'skipped', status: null, charged_micro: 0, detail: 'would exceed max cost' })
      continue
    }
    // treg would start an async job and answer 202 later; a sheet run can't
    // wait for that, so Cubex must exclude these providers. Specs check this flag.
    if (p.async) state.asyncCalled = true
    const answer = providerAnswer(toolId, p, n, body)
    if (answer.error) {
      tried.push({ endpoint_id: p.endpoint_id, provider: p.provider, outcome: 'error', status: answer.error, charged_micro: 0 })
      continue
    }
    const charged = answer.output ? price : 0
    spent += charged
    tried.push({ endpoint_id: p.endpoint_id, provider: p.provider, outcome: answer.output ? 'hit' : 'miss', status: 200, charged_micro: charged })
    if (answer.output) { hit = { p, output: answer.output }; break }
  }
  const contract = fixture(`catalog/endpoints/${toolId}.json`).routing.contract.output
  const empty = Object.fromEntries(Object.keys(contract).map(k => [k, null]))
  const servedBy = hit ? hit.p.endpoint_id : (plan.length === 1 ? plan[0].endpoint_id : null)
  return {
    status: 200, costMicro: spent, servedBy, capped: capped && !hit, outcome: hit ? 'hit' : 'miss',
    tried: tried.map(t => t.provider),
    body: {
      output: hit ? { ...empty, ...hit.output } : empty,
      raw: hit ? { provider: hit.p.provider, data: hit.output } : null,
      _treg: {
        served_by: servedBy, ...(servedBy ? { provider: servedBy.split('.')[0], tier: 'platform' } : {}),
        outcome: hit ? 'hit' : 'miss', tried, charged_micro: spent,
      },
    },
  }
}
