// Which models' providers fetch web pages themselves, from OpenRouter's catalog
// entry for its web fetch tool (GET /tools/openrouter:web_fetch, its
// native_support.models). OpenRouter's 'auto' fetch engine uses that native
// fetch where there is one, billed at the provider's own price, which OpenRouter
// passes on; elsewhere it uses Exa at $0.001 a page
// (https://openrouter.ai/docs/guides/features/server-tools/web-fetch). Read for
// estimate_only, with the account's key, at most once per
// SEARCH_CATALOG_CACHE_TTL_MS and shared; unreadable: unknown (null).
import { OPENROUTER_ATTRIBUTION_HEADERS, OPENROUTER_BASE_URL } from '../lib/constants';
import { SEARCH_CATALOG_CACHE_TTL_MS, SEARCH_CATALOG_RETRY_MS } from '../lib/constants-ai';
import { fetchJsonWithTimeout } from '../lib/openrouter';
import { getOpenRouterApiKey } from './openrouter';

let cache: { models: Set<string> | null; freshUntil: number } | null = null;
let inflight: Promise<void> | null = null;

// The model slugs, lowercased; null when the answer lists none (unknown, not "none fetch on their own").
export function parseFetchCatalog(body: unknown): Set<string> | null {
  const models = (body as { data?: { native_support?: { models?: unknown } } } | null)?.data?.native_support?.models;
  const slugs = Array.isArray(models)
    ? models.map((m: any) => String(m?.slug ?? '').toLowerCase()).filter(Boolean) : [];
  return slugs.length > 0 ? new Set(slugs) : null;
}

async function read(apiKey: string): Promise<Set<string> | null> {
  try {
    const r = await fetchJsonWithTimeout<unknown>(
      `${OPENROUTER_BASE_URL}/tools/openrouter:web_fetch`,
      { Authorization: `Bearer ${apiKey}`, ...OPENROUTER_ATTRIBUTION_HEADERS },
    );
    return r.ok ? parseFetchCatalog(r.body) : null;
  } catch {
    return null;
  }
}

// true or false when the catalog says; false when it can't be read (priced as Exa, as before).
export async function fetchesNatively(userId: string, model: string): Promise<boolean> {
  if (!cache || Date.now() >= cache.freshUntil) {
    const apiKey = getOpenRouterApiKey(userId);
    if (apiKey) {
      inflight ??= read(apiKey).then(models => {
        cache = models
          ? { models, freshUntil: Date.now() + SEARCH_CATALOG_CACHE_TTL_MS }
          : { models: cache?.models ?? null, freshUntil: Date.now() + SEARCH_CATALOG_RETRY_MS };
      }).finally(() => { inflight = null; });
      await inflight;
    }
  }
  return cache?.models?.has(model.split(':')[0].toLowerCase()) ?? false;
}
