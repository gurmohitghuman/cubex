// When a "run finished" notice that didn't get a 2xx is sent again. Pure.
// RUN_HOOK_TRIES tries in all: the second after RUN_HOOK_RETRY_BASE_MS, the
// third after six times that, each ±20%; a receiver's Retry-After asking for
// longer wins, up to a minute more. A URL the guard blocks isn't tried again
// (that won't change between tries); everything else is, until the tries run out.
import { RUN_HOOK_RETRY_BASE_MS, RUN_HOOK_TRIES } from './constants-run-hooks';
import { parseRetryAfter } from './http-retry';

const MAX_RETRY_AFTER_MS = 60_000;

// The wait after `tries` tries, or null when there's no try left.
export function runHookRetryWait(
  tries: number, retryAfter: string | null, now: number, rand: () => number = Math.random,
): number | null {
  if (tries >= RUN_HOOK_TRIES) return null;
  const base = RUN_HOOK_RETRY_BASE_MS * 6 ** (Math.max(1, tries) - 1);
  const backoff = Math.round(base * (0.8 + rand() * 0.4));
  const asked = parseRetryAfter(retryAfter, now);
  return asked === null ? backoff : Math.max(backoff, Math.min(asked, MAX_RETRY_AFTER_MS));
}

export function isDelivered(status: number): boolean {
  return status >= 200 && status < 300;
}

// What the log says about an answer that wasn't a 2xx.
export function answerProblem(status: number): string {
  if (status >= 300 && status < 400) return `The URL answered ${status}. Redirects aren't followed: use the final URL.`;
  return `The URL answered ${status}.`;
}
