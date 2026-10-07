// Completing treg's /access plan for a waterfall (pure). treg plans a
// waterfall's access for the tool's own example input only (its test_request:
// a LinkedIn URL for email find), so a provider that needs other inputs (Hunter
// needs a name and a domain) is missing from the plan, and its "your key" badge
// with it. Each missing provider is asked about through one of its own
// endpoints, and the answer joins the plan as a row of the same shape.
import type { ToolAccess } from './treg'

export interface AccessProvider { provider: string; endpointId: string; unavailable: 'async' | 'retired' | null }

const providerOf = (row: unknown): string | null => {
  const p = (row as { provider?: unknown } | null)?.provider
  return typeof p === 'string' && p ? p.toLowerCase() : null
}

// The waterfall's providers the plan doesn't list, each with the first of its
// endpoints a sheet run can use.
export function missingProviders(providers: AccessProvider[], plan: unknown[] | null): Array<{ provider: string; endpointId: string }> {
  const listed = new Set((plan ?? []).map(providerOf).filter((p): p is string => p !== null))
  const out = new Map<string, string>()
  for (const p of providers) {
    const key = p.provider.toLowerCase()
    if (!p.unavailable && !listed.has(key) && !out.has(key)) out.set(key, p.endpointId)
  }
  return [...out].map(([provider, endpointId]) => ({ provider, endpointId }))
}

// One endpoint's own /access answer as a plan row: own keys and free routes
// cost the team nothing at treg (price 0); `metered` says an own connection is
// still billed through treg.
export function accessRow(provider: string, endpointId: string, child: ToolAccess | null): Record<string, unknown> | null {
  if (!child?.tier) return null
  const priced = child.tier === 'platform' && child.estimatedCostUsd !== null
  return {
    endpoint_id: endpointId, provider, tier: child.tier,
    price_micro: priced ? Math.round((child.estimatedCostUsd as number) * 1e6) : child.tier === 'platform' ? null : 0,
    ...(child.metered !== null ? { metered: child.metered } : {}),
    from_endpoint: true,
  }
}

export function withRows(access: ToolAccess, rows: Array<Record<string, unknown> | null>): ToolAccess {
  const extra = rows.filter((r): r is Record<string, unknown> => r !== null)
  return extra.length ? { ...access, plan: [...(access.plan ?? []), ...extra] } : access
}
