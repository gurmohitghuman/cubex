import { HTTP_REQUEST_CACHE_TTL_MS } from './constants';

// Module-level request cache for makeHTTPRequest (5-min TTL by default). Bounded to
// prevent unbounded memory growth: evict the oldest entry past MAX_CACHE_ENTRIES, skip
// caching responses larger than MAX_CACHED_RESPONSE_BYTES. The cache key is built by the
// caller and includes userId, like every other user-scoped read.
const MAX_CACHE_ENTRIES = 500;
const MAX_CACHED_RESPONSE_BYTES = 256 * 1024;

const requestCache = new Map<string, { response: any; timestamp: number; bytes: number }>();

// Return the cached response for `key` if present and within TTL, else null.
export function getCachedResponse(key: string): any | null {
  const cached = requestCache.get(key);
  if (cached && (Date.now() - cached.timestamp) < HTTP_REQUEST_CACHE_TTL_MS) return cached.response;
  return null;
}

// Bounded cache write. Responses over MAX_CACHED_RESPONSE_BYTES are skipped. Map preserves
// insertion order, so the first key is the oldest — evict it when at capacity.
export function setCachedResponse(key: string, response: any, bodyLength: number): void {
  if (bodyLength > MAX_CACHED_RESPONSE_BYTES) return;
  if (requestCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = requestCache.keys().next().value;
    if (oldestKey !== undefined) requestCache.delete(oldestKey);
  }
  requestCache.set(key, { response, timestamp: Date.now(), bytes: bodyLength });
}
