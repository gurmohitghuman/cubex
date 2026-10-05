// OpenRouter upstream-fetch helpers. All outbound calls to OpenRouter's API
// (key validation, account balance, model list) live here so the settings route
// stays a thin handler. Each fetch has its own 10s abort timeout — a friendly
// failure beats an indefinite spinner if OpenRouter is slow or unreachable.
import {
  OPENROUTER_BASE_URL, OPENROUTER_ATTRIBUTION_HEADERS, OPENROUTER_MODELS_CACHE_TTL_MS,
} from './constants';

const FETCH_TIMEOUT_MS = 10_000;

interface FetchResult<T> { ok: boolean; status: number; body: T | null; }

// fetch + JSON parse under a SINGLE abort timeout, so a server that streams
// headers fast but stalls mid-body can't hang past FETCH_TIMEOUT_MS. The timer
// is cleared only after the body is fully read. A non-OK response returns
// { ok: false, body: null } (the body is not read). A network error, timeout
// (AbortError), or JSON-parse failure THROWS — callers wrap the call to handle
// those, and the thrown AbortError lets them distinguish a timeout.
async function fetchJsonWithTimeout<T>(url: string, headers: Record<string, string>): Promise<FetchResult<T>> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) return { ok: false, status: response.status, body: null };
    const body = await response.json() as T;
    return { ok: true, status: response.status, body };
  } finally { clearTimeout(timeoutId); }
}

export interface KeyAuthData {
  label?: string;
  usage?: number;
  limit?: number | null;
  is_free_tier?: boolean;
}

export type KeyValidation =
  | { ok: true; data?: KeyAuthData }
  | { ok: false; status: number };

// Validates a key against /auth/key. NOTE: this endpoint reports only the KEY's
// lifetime usage + its optional per-key spend cap — NOT the account balance.
// Use fetchAccountBalance for real remaining credits.
export async function validateKey(apiKey: string): Promise<KeyValidation> {
  const result = await fetchJsonWithTimeout<{ data?: KeyAuthData }>(`${OPENROUTER_BASE_URL}/auth/key`, {
    'Authorization': `Bearer ${apiKey}`, ...OPENROUTER_ATTRIBUTION_HEADERS,
  });
  if (!result.ok) return { ok: false, status: result.status };
  return { ok: true, data: result.body?.data };
}

// Account-level remaining balance via /credits (balance = total_credits -
// total_usage). Best-effort: this endpoint may 403 for non-provisioning keys,
// so any non-OK response or network error returns null and the caller falls
// back to the key-usage view.
export async function fetchAccountBalance(apiKey: string): Promise<number | null> {
  try {
    const result = await fetchJsonWithTimeout<{ data?: { total_credits?: number; total_usage?: number } }>(
      `${OPENROUTER_BASE_URL}/credits`,
      { 'Authorization': `Bearer ${apiKey}`, ...OPENROUTER_ATTRIBUTION_HEADERS },
    );
    const d = result.body?.data;
    if (!result.ok || !d || typeof d.total_credits !== 'number' || typeof d.total_usage !== 'number') return null;
    return d.total_credits - d.total_usage;
  } catch { return null; }
}

export interface TrimmedModel {
  id: string;
  name: string;
  description?: string;
  context_length: number;
  pricing: { prompt: string; completion: string };
}

// Module-level cache, shared across requests. The 5-min TTL keeps the upstream
// rate low while staying fresh enough that newly-added models show up promptly.
let modelsCache: { data: TrimmedModel[]; fetchedAt: number } | null = null;

export type ModelsResult =
  | { ok: true; models: TrimmedModel[] }
  | { ok: false; aborted: boolean; status?: number; stale?: TrimmedModel[] };

// Returns the trimmed model list, served from cache when fresh. On any upstream
// failure it falls back to stale cache if present (returned via `stale`), else
// signals the failure so the caller can emit a clean 502.
export async function fetchModels(now: number): Promise<ModelsResult> {
  if (modelsCache && (now - modelsCache.fetchedAt) < OPENROUTER_MODELS_CACHE_TTL_MS) {
    return { ok: true, models: modelsCache.data };
  }

  let result: FetchResult<{ data: any[] }>;
  try {
    // A 200 whose body fails to parse throws inside the helper and is caught
    // here, so a malformed-but-OK response falls back to stale cache too — it
    // never bubbles to a 500.
    result = await fetchJsonWithTimeout<{ data: any[] }>(`${OPENROUTER_BASE_URL}/models`, OPENROUTER_ATTRIBUTION_HEADERS);
  } catch (err: any) {
    return { ok: false, aborted: err?.name === 'AbortError', stale: modelsCache?.data };
  }

  // Treat any unexpected shape (non-OK, missing body, or a `data` that isn't an
  // array) the same as an upstream failure: fall back to stale cache, never let
  // a malformed-but-parseable 200 throw at `.filter` and bubble to a 500.
  if (!result.ok || !result.body || !Array.isArray(result.body.data)) {
    return { ok: false, aborted: false, status: result.status, stale: modelsCache?.data };
  }

  const trimmed: TrimmedModel[] = result.body.data
    .filter(m => m && typeof m.id === 'string')
    .map(m => ({
      id: m.id,
      name: m.name || m.id,
      description: m.description || undefined,
      context_length: typeof m.context_length === 'number' ? m.context_length : 0,
      pricing: { prompt: m.pricing?.prompt || '0', completion: m.pricing?.completion || '0' },
    }));

  modelsCache = { data: trimmed, fetchedAt: now };
  return { ok: true, models: trimmed };
}
