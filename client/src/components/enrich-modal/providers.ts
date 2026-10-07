// A waterfall's providers as Set up lists them (pure). treg's switches
// (X-Treg-Route-Prefer / -Exclude) and its order work per PROVIDER, and a plan
// can list two endpoints of one provider, so each provider is one row: its
// cheapest price, best hit rate, and every identity it accepts.
import type { EnrichToolAccess, EnrichToolProvider } from '@/utils/api'

// own: the team's own key at treg (free to Cubex, billed by the provider);
// connected: an account connected at treg that treg still meters; free: a
// public route with no key. treg always tries these before anything else.
export type ProviderAccess = 'own' | 'connected' | 'free'

export interface ProviderRow {
  provider: string
  name: string
  usd: number | null
  billsMisses: boolean
  hitRate: number | null
  works: number | null
  accepts: string[][]
  unavailable: 'async' | 'retired' | null
  exhausted: boolean   // treg's own account for it is out right now
  access: ProviderAccess | null
}

// Mirrors the server's billsMisses (lib/enrich-estimate.ts): a provider whose
// price per hit is above its price bills misses too; no observed price per hit
// counts as billing them (the safe side).
export function providerBillsMisses(p: Pick<EnrichToolProvider, 'usd' | 'usdPerHit'>): boolean {
  if (!p.usd) return false
  return p.usdPerHit === null || p.usdPerHit > p.usd + 1e-9
}

const maxOf = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b))
const minOf = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b))

// treg's /access plan rows ({provider, tier, price_micro}) for the team.
export function accessByProvider(access: EnrichToolAccess | null): Map<string, ProviderAccess> {
  const out = new Map<string, ProviderAccess>()
  for (const row of access?.plan ?? []) {
    const provider = typeof row.provider === 'string' ? row.provider.toLowerCase() : null
    if (!provider || out.has(provider)) continue
    if (row.tier === 'anonymous') out.set(provider, 'free')
    else if (row.tier === 'tool' || row.tier === 'credential') out.set(provider, row.price_micro === 0 ? 'own' : 'connected')
  }
  return out
}

// One row per provider, in treg's order (its ranking by expected cost per hit).
// Endpoints a sheet run can't use (async, retired) or treg can't serve right
// now (exhausted) don't count toward the price, rate or accepted identities.
export function providerRows(providers: EnrichToolProvider[], access: EnrichToolAccess | null): ProviderRow[] {
  const tiers = accessByProvider(access)
  const groups = new Map<string, EnrichToolProvider[]>()
  for (const p of providers) {
    const key = p.provider.toLowerCase()
    groups.set(key, [...(groups.get(key) ?? []), p])
  }
  return [...groups.entries()].map(([key, eps]) => {
    const runnable = eps.filter(e => !e.unavailable)
    const live = runnable.filter(e => !e.exhausted)
    const basis = live.length ? live : runnable.length ? runnable : eps
    return {
      provider: eps[0].provider, name: eps[0].name ?? eps[0].provider,
      usd: basis.reduce<number | null>((m, e) => minOf(m, e.usd), null),
      billsMisses: basis.some(providerBillsMisses),
      hitRate: basis.reduce<number | null>((m, e) => maxOf(m, e.hitRate), null),
      works: basis.reduce<number | null>((m, e) => maxOf(m, e.works), null),
      accepts: basis.flatMap(e => e.accepts),
      unavailable: runnable.length ? null : eps[0].unavailable,
      exhausted: runnable.length > 0 && live.length === 0,
      access: tiers.get(key) ?? null,
    }
  })
}

// The user's order first (providers they placed), then the rest in treg's order.
export function orderRows(rows: ProviderRow[], order: string[]): ProviderRow[] {
  const at = new Map(order.map((p, i) => [p.toLowerCase(), i]))
  const rank = (r: ProviderRow) => at.get(r.provider.toLowerCase()) ?? order.length
  return [...rows].sort((a, b) => rank(a) - rank(b))
}

// Move one provider up or down among `visible` (the reorderable rows, in
// their current order); returns the new full order.
export function moveProvider(visible: string[], provider: string, delta: -1 | 1): string[] {
  const i = visible.indexOf(provider)
  const j = i + delta
  if (i < 0 || j < 0 || j >= visible.length) return visible
  const next = [...visible]
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}

// Drag and drop: put `provider` where `target` is.
export function dropProvider(visible: string[], provider: string, target: string): string[] {
  if (provider === target) return visible
  const rest = visible.filter(p => p !== provider)
  const at = rest.indexOf(target)
  if (at < 0) return visible
  const from = visible.indexOf(provider), to = visible.indexOf(target)
  rest.splice(from < to ? at + 1 : at, 0, provider)
  return rest
}
