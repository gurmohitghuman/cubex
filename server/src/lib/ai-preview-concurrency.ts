// Per-user cap on CONCURRENT in-flight preview batches (Bug B hardening,
// ). /ai/preview finishes its rows even after a client disconnect
// (deliberate — paid-for rows persist for reuse), so the existing 30/min rate
// limiter doesn't bound how many batches run AT ONCE: disconnect-and-repeat
// could stack many background OpenRouter batches per user (resource risk).
//
// In-memory Map is the right tool here (NOT a DB bucket like the outbound token
// bucket): a preview batch lives entirely in ONE API-process request handler —
// ephemeral, no worker thread, no durable resume, no cross-thread coordination.
// Revisit only if the API goes multi-process / horizontally scaled.
//
// Contract: acquire() AFTER auth + rate limiter, right before the batch starts;
// release() in a finally that wraps the WHOLE async batch so a disconnect, throw,
// or normal finish all decrement exactly once. release is idempotent-safe and
// deletes the entry at zero so the map can't leak keys.

// Max simultaneous preview batches per user. Small: a human previews one column
// at a time; 3 tolerates a quick supersede (old batch still finishing when a new
// one starts) without letting a client stack unbounded background work.
export const MAX_ACTIVE_PREVIEWS_PER_USER = 3;

const active = new Map<string, number>();

// Returns false when the user is already at the cap (caller 429s and does NOT
// start the batch). Returns true AND increments when a slot is granted.
export function acquirePreviewSlot(userId: string): boolean {
  const n = active.get(userId) ?? 0;
  if (n >= MAX_ACTIVE_PREVIEWS_PER_USER) return false;
  active.set(userId, n + 1);
  return true;
}

// Decrement. Clamped at 0 and deletes the entry at zero so a double-release (or
// a release without a matching acquire) can never drive the count negative or
// leak the key. MUST be called in a finally for every acquire that returned true.
export function releasePreviewSlot(userId: string): void {
  const n = active.get(userId) ?? 0;
  if (n <= 1) active.delete(userId);
  else active.set(userId, n - 1);
}
