// The mock treg's state and its control routes (/__mock/*), for e2e specs and
// the preview. In memory: a restart (or POST /__mock/reset) starts over.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURES = fileURLToPath(new URL('fixtures', import.meta.url))
export const fixture = (rel) => JSON.parse(fs.readFileSync(path.join(FIXTURES, rel), 'utf8'))
export const hasFixture = (rel) => fs.existsSync(path.join(FIXTURES, rel))
export const listFixtures = (dir) => fs.readdirSync(path.join(FIXTURES, dir)).filter(f => f.endsWith('.json'))

const defaults = () => ({
  balanceMicro: 1_000_000,
  holdsMicro: 0,
  // Provider slugs the team has its own key for at treg (tier credential), and
  // ones with a free public route (tier anonymous). Everything else is treg's key.
  ownKeys: [],
  freeProviders: [],
  // true: drop every non-mock connection, as an unreachable treg would.
  down: false,
  // Tool calls (calls.mjs, answers.mjs): a failure for the next calls, a delay
  // before each answer, and how finders and checkers answer.
  scenario: null,
  delayMs: 0,
  findMisses: {},
  sameEmail: [],
  verifiedDomains: [],
  verdicts: {},
  // Calls whose request mentions one of these (a domain, an address) answer
  // treg's 400 catalog_parameter_invalid: the row fails (❌), nothing billed.
  badDomains: [],
  // A hit for a request mentioning one of these carries a long raw.sources
  // list (about 30 KB), so Cubex keeps only part of it (lib/answer-trim.ts).
  bigRawDomains: [],
  // List jobs: a search mentioning one of these words returns at most that
  // many rows (lists.mjs; default 10, never above the request's limit).
  listSizes: {},
  // AI engines (ai-search.mjs): engines whose answers cite no sources, and a
  // brand an engine's answer names too ({gemini: 'Acme CRM'}).
  aiQuiet: [],
  aiAlsoNames: {},
  // Set when a call reached an async provider (Cubex must exclude those).
  asyncCalled: false,
})

export const state = defaults()
const requests = []
// Every charge: { key, toolId, costMicro }. GET /__mock/billing.
export const billing = []

// What specs assert on: which routes Cubex called and with which headers. The
// key itself is never kept, only whether one was sent.
export function logRequest(req, url, body) {
  const headers = { ...req.headers }
  const token = headers['x-treg-token']
  delete headers['x-treg-token']
  requests.push({ method: req.method, path: url.pathname, query: url.search, hasToken: !!token, headers, body })
  if (requests.length > 2000) requests.shift()
}

export function adminRoute(req, url, body, send) {
  if (url.pathname === '/__mock/state' && req.method === 'GET') return send(200, state)
  if (url.pathname === '/__mock/state' && req.method === 'POST') {
    let patch = {}
    try { patch = JSON.parse(body || '{}') } catch { return send(400, { error: 'bad json' }) }
    for (const k of Object.keys(defaults())) if (k in patch) state[k] = patch[k]
    return send(200, state)
  }
  if (url.pathname === '/__mock/reset' && req.method === 'POST') {
    Object.assign(state, defaults())
    requests.length = 0
    billing.length = 0
    return send(200, state)
  }
  if (url.pathname === '/__mock/requests' && req.method === 'GET') return send(200, requests)
  if (url.pathname === '/__mock/billing' && req.method === 'GET') return send(200, billing)
  return send(404, { error: 'unknown mock route' })
}
