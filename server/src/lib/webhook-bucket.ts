import {
  WEBHOOK_RATE_PER_SEC,
  WEBHOOK_RATE_BURST,
  WEBHOOK_BUCKET_IDLE_EVICT_MS,
} from './constants';

// Per-SOURCE ingestion rate limiter for POST /api/webhooks/:token.
//
// A hand-rolled in-memory token bucket (NOT a new dependency, NOT
// express-rate-limit — its fixed-window model can't express burst-then-drain;
// NOT rate-limiter-flexible — that only earns its keep with a distributed store,
// and we're single-process better-sqlite3). ~20 lines of plain timing logic, no
// security primitive, so DIY is correct here.
//
// KEYED ON THE STABLE source.id, NOT the token hash (security): keying on the
// token hash let a sender bypass the sustained limit by rotating (new hash →
// fresh full burst). source.id survives rotation, so the limit persists across it.
//
// TWO rules from the OSS security review, both load-bearing:
//   1. NEVER key an UNVALIDATED token into the Map. A random-token spray would
//      otherwise grow the Map unboundedly = memory DoS. Callers MUST resolve the
//      token to a real webhook_source (token_hash lookup → source.id) BEFORE
//      calling take().
//   2. Idle-evict stale entries so deleted webhooks don't linger forever.

interface Bucket {
  tokens: number; // current allowance
  last: number; // wall-clock ms of the last refill
}

const buckets = new Map<string, Bucket>();

// Lazy wall-time refill: instead of a background timer, compute how many tokens
// should have accrued since `last` on each call. capacity = burst, rate = per-sec.
function refill(b: Bucket, now: number): void {
  const elapsedSec = (now - b.last) / 1000;
  if (elapsedSec <= 0) return;
  b.tokens = Math.min(WEBHOOK_RATE_BURST, b.tokens + elapsedSec * WEBHOOK_RATE_PER_SEC);
  b.last = now;
}

export interface RateDecision {
  allowed: boolean;
  // Seconds until at least one token is available again (for Retry-After). 0 when allowed.
  retryAfterSec: number;
}

// Consume one token for sourceId (the stable webhook_sources.id). Returns whether
// the request is allowed and, if not, a Retry-After hint. ONLY call after the
// token has been validated to a real source (rule #1).
export function takeWebhookToken(sourceId: string, now: number = Date.now()): RateDecision {
  let b = buckets.get(sourceId);
  if (!b) {
    // First request for this source: start full, spend one.
    buckets.set(sourceId, { tokens: WEBHOOK_RATE_BURST - 1, last: now });
    return { allowed: true, retryAfterSec: 0 };
  }
  refill(b, now);
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { allowed: true, retryAfterSec: 0 };
  }
  // Time for the bucket to accrue one whole token.
  const deficit = 1 - b.tokens;
  const retryAfterSec = Math.max(1, Math.ceil(deficit / WEBHOOK_RATE_PER_SEC));
  return { allowed: false, retryAfterSec };
}

// Drop a source's bucket immediately — call on delete so a removed webhook
// doesn't keep a stale entry. NOT called on rotate: rotate keeps the same
// source.id, so the rate limit deliberately persists across it.
export function dropWebhookBucket(sourceId: string): void {
  buckets.delete(sourceId);
}

// Drop buckets for many sources at once. Used by sheet-delete and table-delete,
// which CASCADE webhook_sources away. The caller MUST capture the source ids
// BEFORE the delete txn (the rows are gone after commit, so they can't be looked
// up by sheet_id afterward) and call this AFTER the txn commits (this mutates the
// in-memory Map, not the DB, and shouldn't run if the delete rolled back).
export function dropBucketsForSheets(capturedSourceIds: string[]): void {
  for (const id of capturedSourceIds) buckets.delete(id);
}

// Periodic idle-eviction (rule #2). An entry whose last touch is older than the
// idle window is removed. Cheap O(n) sweep over a Map that's bounded by the
// number of ACTIVE webhooks (one per sheet), so n is small.
export function evictIdleWebhookBuckets(now: number = Date.now()): number {
  let removed = 0;
  for (const [hash, b] of buckets) {
    if (now - b.last >= WEBHOOK_BUCKET_IDLE_EVICT_MS) {
      buckets.delete(hash);
      removed++;
    }
  }
  return removed;
}
