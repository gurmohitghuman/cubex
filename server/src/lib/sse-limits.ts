import type { Response } from 'express';

// Per-user cap on concurrent SSE connections + per-connection idle timeout.
//
// Without these, a single authenticated user could open hundreds of
// EventSource connections to /api/ai/runs/:id/stream (or .../http/jobs/:id/stream)
// in a loop. Each one holds a TCP socket, a setInterval timer, and a few
// prepared statements. The browser's per-host EventSource limit is ~6 per
// page, but the EventSource API can be invoked from JS with arbitrary URLs,
// and a malicious client (curl, custom JS) bypasses that limit entirely.
//
// Numbers:
// - MAX_PER_USER = 16: covers the realistic worst case. A user can have up
//   to 10 active runs (5 AI + 5 HTTP, capped by lib/limits.ts), and on page
//   load reconnectActiveRuns opens one EventSource per active run. 8 was
//   too tight — a user with 5+5 runs refreshing the page would have 2
//   streams 429'd. 16 gives headroom for that plus a second tab.
// - MAX_LIFETIME_MS = 1 hour: even legitimate clients get reaped after an
//   hour. The client EventSource auto-reconnects, so this is invisible to
//   real users but caps any one connection's resource hold.
// - MAX_TOTAL = 256: process-wide ceiling. The per-user cap alone doesn't
//   bound aggregate resource use — N verified accounts × 16 each = 16N open
//   sockets + timers with no global limit. 256 is ~16 fully-saturated users
//   on the 4-vCPU/8GB prod box; honest usage is far below this, and a client
//   that hits it just retries (EventSource auto-reconnects). Override via
//   SSE_MAX_TOTAL if the box is sized differently.

const MAX_PER_USER = 16;
const MAX_TOTAL = parseInt(process.env.SSE_MAX_TOTAL || '256', 10);
const MAX_LIFETIME_MS = 60 * 60 * 1000;

const counts = new Map<string, number>();
let totalCount = 0;

export interface SSELease {
  // Call when the connection ends (req.on('close') OR after sending the
  // max-lifetime close). Idempotent.
  release: () => void;
  // Set up by acquireSSESlot; the caller wires it into setInterval(tick).
  // After MAX_LIFETIME_MS, the timer fires once, closes the response, and
  // the lease is auto-released.
  timeoutHandle: NodeJS.Timeout;
}

/**
 * Try to claim an SSE slot for `userId`. Returns null if the user is at the
 * cap (the caller should respond with 429). Returns a lease otherwise; the
 * caller MUST call `release()` exactly once when the connection closes.
 *
 * The lease also schedules a hard close at MAX_LIFETIME_MS — clients
 * auto-reconnect, so this is transparent to honest clients and bounds the
 * resource hold of malicious ones.
 */
export function acquireSSESlot(userId: string, res: Response, onTimeout: () => void): SSELease | null {
  // Process-wide ceiling first, then the per-user cap. Both must have room.
  if (totalCount >= MAX_TOTAL) return null;
  const current = counts.get(userId) ?? 0;
  if (current >= MAX_PER_USER) return null;
  counts.set(userId, current + 1);
  totalCount++;

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const n = counts.get(userId) ?? 1;
    if (n <= 1) counts.delete(userId);
    else counts.set(userId, n - 1);
    totalCount--;
    clearTimeout(timeoutHandle);
  };

  const timeoutHandle = setTimeout(() => {
    // Best-effort: notify the client we're closing, run the caller's
    // cleanup (clearInterval of poll timer + res.end), and release the slot.
    try { res.write(`data: ${JSON.stringify({ type: 'reconnect', reason: 'max_lifetime' })}\n\n`); } catch { /* dead socket */ }
    try { onTimeout(); } catch { /* never crash on timeout */ }
    release();
  }, MAX_LIFETIME_MS);

  return { release, timeoutHandle };
}

export const SSE_MAX_PER_USER = MAX_PER_USER;
