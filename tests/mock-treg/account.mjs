// Account reads, as treg answers them (fixtures/account, captured live): the
// key check, the team, and its balance. Keys: anything starting treg_mock_ is a
// team key; treg_mock_personal… is a personal login token; treg_mock_setup… a
// team that hasn't finished setup; anything else is refused.
import { fixture, state } from './state.mjs'

// null when the key is a good team key, else treg's refusal for it.
export function refuseKey(req) {
  const token = req.headers['x-treg-token']
  if (!token) return { status: 401, body: { detail: 'Not authenticated' } }
  if (token.startsWith('treg_mock_personal')) return { status: 400, body: { detail: 'choose an org (send X-Treg-Org)' } }
  if (token.startsWith('treg_mock_setup')) return { status: 403, body: { detail: 'finish team setup first' } }
  if (!token.startsWith('treg_mock_')) return { status: 401, body: { detail: 'invalid token' } }
  return null
}

function balanceBody() {
  const base = fixture('account/balance.json')
  const holds = state.holdsMicro > 0
    ? [{ id: 'hold_0001', amount_micro: state.holdsMicro, endpoint_id: 'treg.people.email.find', created_at: '2026-10-07T21:30:00' }]
    : []
  return {
    ...base,
    balance_micro: state.balanceMicro,
    balance_usd: state.balanceMicro / 1e6,
    holds,
    entries: { ...base.entries, items: base.entries.items.slice(0, 1) },
  }
}

export function accountRoute(req, url) {
  const p = url.pathname
  if (req.method !== 'GET') return null
  if (p !== '/usage/me' && p !== '/auth/me' && !/^\/orgs\/[^/]+\/balance$/.test(p)) return null
  const refused = refuseKey(req)
  if (refused) return refused
  if (p === '/usage/me') return { status: 200, body: fixture('account/usage-me.json') }
  if (p === '/auth/me') return { status: 200, body: fixture('account/auth-me.json') }
  const orgId = p.split('/')[2]
  if (orgId !== String(fixture('account/auth-me.json').org_id)) return { status: 403, body: { detail: 'not a member of this org' } }
  return { status: 200, body: balanceBody() }
}
