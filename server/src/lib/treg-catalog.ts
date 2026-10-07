// treg's public catalog (no key needed): search, one tool's details, and the
// provider display names. Each path's answer is cached slimmed down to the
// fields Cubex reads, in a small LRU (search runs on debounced typing). A
// fresh entry answers at once; an expired one answers at once too, marked
// stale, while one background fetch refreshes it, so a slow or unreachable
// treg never holds up the drawer. A tool treg no longer has drops out.
import { TREG_CATALOG_CACHE_MAX_ENTRIES, TREG_CATALOG_CACHE_TTL_MS, TREG_SEARCH_LIMIT, TREG_TOOL_ID_PATTERN } from './constants';
import { tregGetJson } from './treg';

export type CatalogRead<T> =
  | { ok: true; body: T; stale?: boolean }
  | { ok: false; status?: number; unreachable?: boolean };

type Slim = (body: unknown) => unknown;
const STALE_KEEP_MS = 3 * TREG_CATALOG_CACHE_TTL_MS;
const MAX_EXAMPLE_CHARS = 64 * 1024;

const cache = new Map<string, { body: unknown; at: number }>();
const inflight = new Map<string, Promise<CatalogRead<unknown>>>();

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const pick = (o: unknown, keys: string[]) =>
  (isObj(o) ? Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]])) : undefined);

// Only what enrich-tool.ts reads from an endpoint view.
function slimEndpoint(ep: unknown, withInput: boolean): unknown {
  if (!isObj(ep)) return ep;
  return {
    ...pick(ep, ['id', 'name', 'summary', 'provider', 'provider_display', 'kind', 'method', 'capability',
      'capability_description', 'platform', 'platform_label', 'async', 'status', 'superseded_by',
      'platform_eligible', 'platform_blocked', 'overflow_price_usd', 'strict_query', 'routed_children']),
    cost: pick(ep.cost, ['type', 'unit', 'usd', 'varies', 'note']),
    observed: pick(ep.observed, ['ok_rate', 'hit_rate', 'samples', 'hit_samples']),
    input: withInput ? ep.input : pick(ep.input, ['bodyType']),
  };
}

const slimSearch: Slim = body => (isObj(body)
  ? { total: body.total, results: Array.isArray(body.results) ? body.results.map(r => slimEndpoint(r, false)) : [] }
  : body);

const slimDetail: Slim = body => {
  if (!isObj(body)) return body;
  const example = body.example_response;
  const keepExample = example !== undefined && JSON.stringify(example ?? null).length <= MAX_EXAMPLE_CHARS;
  return {
    endpoint: slimEndpoint(body.endpoint, true),
    routing: isObj(body.routing) ? pick(body.routing, ['contract', 'plan']) : undefined,
    // The same job's other endpoints, waterfall children included: only what
    // says a child can't run in a sheet (it answers later, or is retired).
    siblings: Array.isArray(body.siblings)
      ? body.siblings.filter(isObj).map(s => ({ id: s.id, async: !!s.async, retired: !!(s.status || s.superseded_by) }))
      : undefined,
    example_response: keepExample ? example : null,
  };
};

function remember(path: string, body: unknown): void {
  cache.delete(path);
  cache.set(path, { body, at: Date.now() });
  while (cache.size > TREG_CATALOG_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function purgeExpired(now: number): void {
  for (const [path, entry] of cache) if (now - entry.at > STALE_KEEP_MS) cache.delete(path);
}

function refresh(path: string, slim?: Slim): Promise<CatalogRead<unknown>> {
  let pending = inflight.get(path);
  if (!pending) {
    pending = (async (): Promise<CatalogRead<unknown>> => {
      try {
        const res = await tregGetJson<unknown>(path);
        if (res.status === 200 && res.body !== null) {
          const body = slim ? slim(res.body) : res.body;
          remember(path, body);
          return { ok: true, body };
        }
        if (res.status === 404 || res.status === 410) cache.delete(path);
        return { ok: false, status: res.status };
      } catch {
        return { ok: false, unreachable: true };
      }
    })().finally(() => inflight.delete(path));
    inflight.set(path, pending);
  }
  return pending;
}

export async function catalogGet<T>(path: string, slim?: Slim): Promise<CatalogRead<T>> {
  const now = Date.now();
  purgeExpired(now);
  const hit = cache.get(path);
  if (hit) {
    cache.delete(path); cache.set(path, hit); // LRU touch
    if (now - hit.at >= TREG_CATALOG_CACHE_TTL_MS) {
      refresh(path, slim).catch(() => {});
      return { ok: true, body: hit.body as T, stale: true };
    }
    return { ok: true, body: hit.body as T };
  }
  return (await refresh(path, slim)) as CatalogRead<T>;
}

export interface CatalogSearchBody { results?: unknown[]; total?: number }

export function searchCatalog(query: string): Promise<CatalogRead<CatalogSearchBody>> {
  const q = query.trim().slice(0, 200);
  return catalogGet<CatalogSearchBody>(`/catalog/search?q=${encodeURIComponent(q)}&limit=${TREG_SEARCH_LIMIT}`, slimSearch);
}

export async function getCatalogEndpoint(toolId: string): Promise<CatalogRead<Record<string, unknown>>> {
  if (!TREG_TOOL_ID_PATTERN.test(toolId)) return { ok: false, status: 404 };
  return catalogGet<Record<string, unknown>>(`/catalog/endpoints/${encodeURIComponent(toolId)}`, slimDetail);
}

// Provider slug → display name ("leadmagic" → "LeadMagic"); falls back to the slug.
export async function providerNames(): Promise<Record<string, string>> {
  const res = await catalogGet<{ providers?: Record<string, unknown> }>('/catalog/platforms', b => (isObj(b) ? { providers: b.providers } : b));
  const out: Record<string, string> = {};
  if (res.ok && isObj(res.body.providers)) {
    for (const [slug, name] of Object.entries(res.body.providers)) if (typeof name === 'string') out[slug] = name;
  }
  return out;
}

// Test hook: the unit tests run several scenarios in one process.
export function clearCatalogCache(): void { cache.clear(); inflight.clear(); }
