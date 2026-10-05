// Tiny in-process sliding-window rate guard for limits express-rate-limit
// middleware can't wrap (MCP tool calls, and run starts on both surfaces).
// Per-process is correct for those: they run on the main server thread only.
// Mirrors the size backstop pattern of access-token-auth's lastUsedWrites map.

export interface RateDecision {
  allowed: boolean;
  limit: number;
  windowSec: number;
  // When refused: seconds until the oldest hit leaves the window and frees a slot.
  retryAfterSec: number;
}

// Each call takes a slot when one is free.
export function makeRateWindow(maxPerWindow: number, windowMs = 60_000, mapMax = 10_000) {
  const hits = new Map<string, number[]>();
  const windowSec = Math.round(windowMs / 1000);
  return function take(key: string): RateDecision {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter(t => now - t < windowMs);
    if (recent.length >= maxPerWindow) {
      hits.set(key, recent);
      const retryAfterSec = Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000));
      return { allowed: false, limit: maxPerWindow, windowSec, retryAfterSec };
    }
    recent.push(now);
    if (hits.size >= mapMax && !hits.has(key)) hits.clear();
    hits.set(key, recent);
    return { allowed: true, limit: maxPerWindow, windowSec, retryAfterSec: 0 };
  };
}

export const tooManyMessage = (what: string, d: RateDecision): string =>
  `Too many ${what} (${d.limit} a minute). Try again in ${d.retryAfterSec} second${d.retryAfterSec === 1 ? '' : 's'}.`;

// A 429 from a window must describe THAT limit. The request limiter
// (lib/limits.ts) has already set its own RateLimit-* headers on the response,
// which would tell the client it still has quota; these replace them.
export function setRateLimitedHeaders(res: { setHeader(name: string, value: string | number): unknown }, d: RateDecision): void {
  res.setHeader('Retry-After', d.retryAfterSec);
  res.setHeader('RateLimit-Policy', `${d.limit};w=${d.windowSec}`);
  res.setHeader('RateLimit-Limit', d.limit);
  res.setHeader('RateLimit-Remaining', 0);
  res.setHeader('RateLimit-Reset', d.retryAfterSec);
}
