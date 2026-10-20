// /call/<tool> and /calls/<id>/result, as treg answers them (shapes from the
// live captures in fixtures/calls). Waterfalls run through waterfall.mjs,
// single tools answer their catalog example. Each answer with a call id is
// kept under its Idempotency-Key: the same key and request replays it for
// free (cost 0, the original cost echoed), another request under that key is
// a 422. Every charge lands in the billing log, so specs can check that each
// key was billed once. Steering (all in /__mock/state):
//   scenario {kind, count}: the next `count` calls answer `kind`: 401,
//     insufficient (402 balance), saturated (503), in_progress (409),
//     daily_cap (429), unreachable (500, no call id), firewall (403, no call id)
//   delayMs: every call waits this long first; balanceMicro: what's left;
//   badDomains: requests mentioning one answer 400 catalog_parameter_invalid.
import crypto from 'node:crypto'
import { fixture, hasFixture, state, billing } from './state.mjs'
import { refuseKey } from './account.mjs'
import { isWaterfall, runWaterfall } from './waterfall.mjs'
import { aiSearchAnswer, isAiSearch } from './ai-search.mjs'

const callId = () => crypto.randomBytes(16).toString('hex')
const keys = new Map()        // Idempotency-Key → { fingerprint, answer }
const inFlight = new Set()
const stored = new Map()      // call id → kept single-tool answer
export function resetCalls() { keys.clear(); inFlight.clear(); stored.clear() }

const refusal = (status, detail, extra = {}) => ({ status, headers: { 'X-Treg-Call-Id': callId(), 'X-Treg-Error': '1', ...extra }, body: { detail } })

function scenarioAnswer() {
  const s = state.scenario
  if (!s || !(s.count > 0)) return null
  s.count -= 1
  switch (s.kind) {
    case '401': return refusal(401, 'invalid token')
    case 'insufficient': return refusal(402, { error: 'insufficient_balance', message: 'balance too low', balance_micro: state.balanceMicro, estimated_cost_micro: 5000, topup_url: '/app#billing', autotopup_enabled: false })
    case 'saturated': return { status: 503, headers: { 'Retry-After': '1' }, body: { treg_saturated: true, detail: 'treg is busy' } }
    case 'in_progress': return refusal(409, 'a request with this Idempotency-Key is still in progress')
    case 'daily_cap': return refusal(429, { error: 'daily_cap_reached', message: "this team's daily cap is reached" })
    case 'unreachable': return { status: 500, headers: {}, body: { detail: 'upstream connect error' } }
    case 'firewall': return { status: 403, headers: {}, body: 'Forbidden' }
    default: return null
  }
}

function singleTool(toolId, req, body) {
  const d = hasFixture(`catalog/endpoints/${toolId}.json`) ? fixture(`catalog/endpoints/${toolId}.json`) : null
  if (!d) return { status: 404, refusal: `no tool '${toolId}' in this org` }
  const provider = d.endpoint.provider ?? toolId.split('.')[0]
  const own = state.ownKeys.includes(provider)
  const nobody = (req.query + req.body).toLowerCase().includes('nobody')
  const answered = isAiSearch(toolId) ? aiSearchAnswer(toolId, body) : d.example_response ?? { ok: true }
  return {
    status: 200, body: nobody ? {} : answered,
    costMicro: own ? null : Math.round((d.endpoint.cost?.usd ?? 0) * 1e6), servedBy: toolId, single: true,
  }
}

function answer(toolId, req) {
  let body = {}
  if (req.body) {
    const text = req.headers['x-treg-body-encoding'] === 'base64' ? Buffer.from(req.body, 'base64').toString('utf8') : req.body
    try { body = JSON.parse(text) } catch { return refusal(400, 'body is not JSON') }
  }
  const raw = JSON.stringify(body).toLowerCase() + req.query.toLowerCase()
  const bad = (state.badDomains ?? []).find(d => raw.includes(String(d).toLowerCase()))
  if (bad) return refusal(400, { error: 'catalog_parameter_invalid', message: `${bad} is not a valid domain` })
  const run = isWaterfall(toolId) ? runWaterfall(toolId, body, req.headers) : singleTool(toolId, req, body)
  if (run.refusal) return refusal(run.status, run.refusal)
  const cost = run.costMicro
  if (cost !== null && cost > state.balanceMicro) {
    return refusal(402, { error: 'insufficient_balance', message: `${toolId} would cost more than this team's balance`, balance_micro: state.balanceMicro, estimated_cost_micro: cost, topup_url: '/app#billing', autotopup_enabled: false })
  }
  if (cost) state.balanceMicro -= cost
  const id = callId()
  const headers = { 'X-Treg-Call-Id': id }
  if (cost !== null) headers['X-Treg-Cost-Micro'] = String(cost)
  if (run.servedBy) headers['X-Treg-Served-By'] = run.servedBy
  if (!run.single) {
    headers['X-Treg-Route-Outcome'] = run.outcome
    headers['X-Treg-Providers-Tried'] = run.tried.join(',')
    if (run.capped) headers['X-Treg-Route-Capped'] = 'true'
  } else if (cost) stored.set(id, run.body)
  return { status: 200, headers, body: run.body, cost: cost ?? 0 }
}

export async function callRoute(req, url, rawBody) {
  const result = /^\/calls\/([^/]+)\/result$/.exec(url.pathname)
  if (result && req.method === 'GET') {
    const id = decodeURIComponent(result[1])
    const kept = stored.get(id)
    return { status: 200, headers: {}, body: { call_ref: id, stored: !!kept, status_code: kept ? 200 : null, response: kept ?? null } }
  }
  if (!url.pathname.startsWith('/call/')) return null
  const refused = refuseKey(req)
  if (refused) return { ...refused, headers: { 'X-Treg-Call-Id': callId(), 'X-Treg-Error': '1' } }
  const toolId = decodeURIComponent(url.pathname.slice('/call/'.length))
  const key = req.headers['idempotency-key']
  const fingerprint = `${req.method}|${url.pathname}|${url.search}|${rawBody}`
  if (key && inFlight.has(key)) return refusal(409, 'a request with this Idempotency-Key is still in progress')
  if (key && keys.has(key)) {
    const kept = keys.get(key)
    if (kept.fingerprint !== fingerprint) return refusal(422, `Idempotency-Key '${key}' was already used for a different request.`)
    const headers = { ...kept.answer.headers }
    if (headers['X-Treg-Cost-Micro'] !== undefined) {
      headers['X-Treg-Original-Cost-Micro'] = headers['X-Treg-Cost-Micro']
      headers['X-Treg-Cost-Micro'] = '0'
    }
    headers['X-Treg-Idempotent-Replay'] = 'true'
    return { status: kept.answer.status, headers, body: kept.answer.body }
  }
  if (key) inFlight.add(key)
  // Calls still being answered (GET /__mock/state inFlightCount): a spec that
  // stops a run waits for 0, so a late charge can't land in the next spec's log.
  state.inFlightCount = (state.inFlightCount ?? 0) + 1
  try {
    if (state.delayMs > 0) await new Promise(resolve => setTimeout(resolve, state.delayMs))
    const out = scenarioAnswer() ?? answer(toolId, { method: req.method, headers: req.headers, query: url.search, body: rawBody })
    if (out.cost) billing.push({ key: key ?? null, toolId, costMicro: out.cost })
    // A 409 means "still running": nothing is kept for it.
    if (key && out.headers?.['X-Treg-Call-Id'] && out.status !== 409) keys.set(key, { fingerprint, answer: out })
    return out
  } finally {
    if (key) inFlight.delete(key)
    state.inFlightCount -= 1
  }
}
