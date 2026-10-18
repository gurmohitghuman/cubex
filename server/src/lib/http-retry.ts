// When a failed HTTP API column request is tried again, and after how long.
// Pure (the clock and the random source are arguments) except the wait itself.
//   - 429 and 503 are retried for every method: the API didn't process the request.
//   - Any other 5xx (not 501/505, which a retry won't change) and network errors
//     (refused, reset, timed out) are retried only for GET, HEAD, PUT and DELETE,
//     which are safe to send twice; POST and PATCH too when the column says so.
//   - Nothing else: a 4xx, a body that isn't JSON, a blocked URL or a {{typo}}
//     comes back the same way.
// The wait doubles from HTTP_RETRY_BASE_MS with jitter, or follows the API's
// Retry-After (seconds or a date), never longer than HTTP_RETRY_MAX_WAIT_MS.
import {
  HTTP_RETRY_BASE_MS, HTTP_RETRY_DEFAULT, HTTP_RETRY_MAX, HTTP_RETRY_MAX_WAIT_MS, HTTP_RETRY_STOP_POLL_MS,
} from './constants-http-retry';
import { NetworkError, UpstreamStatusError } from './http-errors';

export interface RetryPolicy { retries: number; retryPost: boolean }

// A stored config's choice; absent (older columns) means the default.
export function retryPolicyOf(config: { retries?: unknown; retryPost?: unknown }): RetryPolicy {
  const r = config.retries;
  const retries = typeof r === 'number' && Number.isInteger(r)
    ? Math.max(0, Math.min(r, HTTP_RETRY_MAX)) : HTTP_RETRY_DEFAULT;
  return { retries, retryPost: config.retryPost === true };
}

export type TryFailure =
  | { kind: 'status'; status: number; retryAfter: string | null }
  | { kind: 'network' }
  | { kind: 'other' };

export function tryFailureOf(error: unknown): TryFailure {
  if (error instanceof UpstreamStatusError) {
    return { kind: 'status', status: error.status, retryAfter: error.retryAfter };
  }
  if (error instanceof NetworkError) return { kind: 'network' };
  return { kind: 'other' };
}

const SAFE_TO_REPEAT = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);

export function isRetryable(f: TryFailure, method: string, retryPost: boolean): boolean {
  if (f.kind === 'other') return false;
  if (f.kind === 'status') {
    if (f.status === 429 || f.status === 503) return true;
    if (f.status < 500 || f.status > 599 || f.status === 501 || f.status === 505) return false;
  }
  return SAFE_TO_REPEAT.has(method.toUpperCase()) || retryPost;
}

// Retry-After in milliseconds from `now`: whole or decimal seconds, or an HTTP
// date. Null when absent or unreadable; never negative.
export function parseRetryAfter(value: string | null | undefined, now: number): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const v = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  // A date names its day or month ("Sat, 17 Oct 2026 12:00:10 GMT"); Date.parse
  // alone also takes "-5" or "7" as one.
  if (!/[A-Za-z]{3}/.test(v)) return null;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

// The wait before the next try, after `attempt` tries (1 = the first one failed).
export function retryWaitMs(f: TryFailure, attempt: number, now: number, rand: () => number = Math.random): number {
  const after = f.kind === 'status' ? parseRetryAfter(f.retryAfter, now) : null;
  if (after !== null) {
    // A little jitter so rows told the same Retry-After don't all come back at once.
    const jitter = Math.floor(rand() * Math.min(1000, after * 0.1));
    return Math.min(after + jitter, HTTP_RETRY_MAX_WAIT_MS);
  }
  const step = Math.min(HTTP_RETRY_BASE_MS * 2 ** (Math.max(1, attempt) - 1), HTTP_RETRY_MAX_WAIT_MS);
  return Math.round(step / 2 + (rand() * step) / 2);
}

// Null: don't try again (not retryable, or the column's retries are used up).
export function nextRetryWait(
  f: TryFailure, method: string, attempt: number, policy: RetryPolicy, now: number, rand?: () => number,
): number | null {
  if (attempt > policy.retries || !isRetryable(f, method, policy.retryPost)) return null;
  return retryWaitMs(f, attempt, now, rand);
}

// Waits `ms`, checking `stopped` (a pause, a cancel, a resume elsewhere) and the
// signal as it goes. False when it stopped: the row is left for its run to pick up.
export async function waitUnlessStopped(
  ms: number, stopped: () => boolean, signal?: AbortSignal, pollMs = HTTP_RETRY_STOP_POLL_MS,
): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (signal?.aborted || stopped()) return false;
    const left = end - Date.now();
    if (left <= 0) return true;
    await new Promise(resolve => setTimeout(resolve, Math.min(left, pollMs)));
  }
}
