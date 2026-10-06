// OpenRouter's catalog entry for its web search tool (GET /tools/
// openrouter:web_search): what each engine and mode costs, and which models'
// providers run search themselves. It needs an API key, so it's read with the
// account's key, at most once per SEARCH_CATALOG_CACHE_TTL_MS, and shared. When
// it can't be read (no key yet, OpenRouter down), the last good copy serves,
// and failing that the static fallbacks (web-search-pricing.ts, -plan.ts).
// Only the main process reads it: a run stores its plan when it starts, and its
// rows send exactly that.
import { OPENROUTER_ATTRIBUTION_HEADERS, OPENROUTER_BASE_URL } from '../lib/constants';
import { SEARCH_CATALOG_CACHE_TTL_MS, SEARCH_CATALOG_RETRY_MS } from '../lib/constants-ai';
import { fetchJsonWithTimeout, fetchModels } from '../lib/openrouter';
import { parseSearchCatalog, planWebSearch, type SearchCatalogView, type SearchPlan } from '../lib/web-search-plan';
import { DEFAULT_SEARCH_OPTIONS, type SearchOptions } from '../lib/web-search-options';
import { getOpenRouterApiKey } from './openrouter';

const UNREAD: SearchCatalogView = { prices: {}, nativeModels: null };

// freshUntil: a good read lasts the TTL; after a failed one the last good copy
// (or the fallbacks) serves for SEARCH_CATALOG_RETRY_MS.
let cache: { view: SearchCatalogView; freshUntil: number } | null = null;
let inflight: Promise<SearchCatalogView | null> | null = null;

async function readCatalog(apiKey: string): Promise<SearchCatalogView | null> {
  try {
    const r = await fetchJsonWithTimeout<unknown>(
      `${OPENROUTER_BASE_URL}/tools/openrouter:web_search`,
      { Authorization: `Bearer ${apiKey}`, ...OPENROUTER_ATTRIBUTION_HEADERS },
    );
    return r.ok ? parseSearchCatalog(r.body) : null;
  } catch {
    return null;
  }
}

export async function searchCatalog(userId: string): Promise<SearchCatalogView> {
  if (cache && Date.now() < cache.freshUntil) return cache.view;
  const apiKey = getOpenRouterApiKey(userId);
  if (!apiKey) return cache?.view ?? UNREAD;
  // One read at a time: a burst of previews or estimates shares it.
  inflight ??= readCatalog(apiKey).then(view => {
    cache = view
      ? { view, freshUntil: Date.now() + SEARCH_CATALOG_CACHE_TTL_MS }
      : { view: cache?.view ?? UNREAD, freshUntil: Date.now() + SEARCH_CATALOG_RETRY_MS };
    return view;
  }).finally(() => { inflight = null; });
  await inflight;
  return cache?.view ?? UNREAD;
}

// The search plan for a run, preview or estimate on this model
// (lib/web-search-plan.ts): null without web search, or why it can't run.
export async function planIfSearching(
  userId: string, model: string, webSearch: boolean, opts: SearchOptions | null | undefined,
): Promise<{ ok: SearchPlan | null } | { error: string }> {
  if (!webSearch) return { ok: null };
  // Also warms the model list, which search rows read to learn whether the
  // model takes a temperature (services/ai-model-call.ts).
  const [catalog] = await Promise.all([searchCatalog(userId), fetchModels(Date.now())]);
  return planWebSearch(opts ?? DEFAULT_SEARCH_OPTIONS, model, catalog);
}
