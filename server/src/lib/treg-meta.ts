// What treg's response headers say about one tool call (pure). Names and
// meanings come from treg's source and the live answers captured on
// 2026-10-07 (tests/mock-treg/fixtures/calls): a waterfall answer always
// carries X-Treg-Cost-Micro (0 when every provider was the team's own key), an
// own-key or free single call may carry none (unmetered), and an idempotent
// replay costs 0 and echoes the first charge.
export interface TregMeta {
  costMicro: number | null;          // null: unmetered (own key, free route)
  originalCostMicro: number | null;  // what a replayed answer first cost
  callId: string | null;
  tregError: boolean;                // X-Treg-Error: 1, treg's own refusal
  servedBy: string | null;           // endpoint id, e.g. quickenrich.people.email.find
  servedVia: string | null;          // overflow:<aggregator>
  routeOutcome: string | null;       // hit | weak | miss
  routeCapped: boolean;
  providersTried: string[];
  cacheHit: boolean;
  replay: boolean;
  retryAfterSec: number | null;
}

type HeaderSource = { get(name: string): string | null } | Record<string, string | undefined>;

function reader(h: HeaderSource): (name: string) => string | null {
  if (typeof (h as { get?: unknown }).get === 'function') return name => (h as { get(n: string): string | null }).get(name);
  const lower = new Map(Object.entries(h as Record<string, string | undefined>).map(([k, v]) => [k.toLowerCase(), v]));
  return name => lower.get(name.toLowerCase()) ?? null;
}

const MICRO_RE = /^\d{1,15}$/;
const micro = (v: string | null): number | null => (v !== null && MICRO_RE.test(v.trim()) ? Number(v.trim()) : null);
const text = (v: string | null, max = 200): string | null => (v && v.trim() ? v.trim().slice(0, max) : null);
const yes = (v: string | null) => !!v && /^(1|true|yes)$/i.test(v.trim());

export function readTregMeta(headers: HeaderSource): TregMeta {
  const get = reader(headers);
  const retry = get('retry-after');
  const retryAfterSec = retry !== null && /^\d{1,4}$/.test(retry.trim()) ? Number(retry.trim()) : null;
  const cache = (get('x-treg-cache') ?? '').toLowerCase();
  return {
    costMicro: micro(get('x-treg-cost-micro')),
    originalCostMicro: micro(get('x-treg-original-cost-micro')),
    callId: text(get('x-treg-call-id'), 100),
    tregError: (get('x-treg-error') ?? '').trim() === '1',
    servedBy: text(get('x-treg-served-by')),
    servedVia: text(get('x-treg-served-via')),
    routeOutcome: text(get('x-treg-route-outcome'), 20)?.toLowerCase() ?? null,
    routeCapped: yes(get('x-treg-route-capped')),
    providersTried: (get('x-treg-providers-tried') ?? '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 50),
    cacheHit: cache === 'hit' || cache === 'stale',
    replay: yes(get('x-treg-idempotent-replay')),
    retryAfterSec,
  };
}

// The provider slug of an endpoint id: "quickenrich.people.email.find" → "quickenrich".
export const providerOf = (endpointId: string | null | undefined): string | null =>
  (endpointId ? endpointId.split('.')[0] || null : null);
