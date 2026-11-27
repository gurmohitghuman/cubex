// The brake on an AI or HTTP API run: rows failing in a row for a reason on
// the provider's or the account's side (no answer, 5xx, 429 after its retries,
// a rejected key, no credits, a model that's gone) pause the run once there
// are RUN_BREAKER_FAILURES of them, so an outage leaves the rest of the sheet
// ⏳ for Resume instead of writing ❌ into every row. A row the provider
// answered, even with an error about the row itself, resets the count. A
// failure on the account's side (a key the provider refuses, no credits, a
// model that's gone: every row would fail the same) stops it at once. A run
// someone started waits out a short outage first (lib/run-brake-waits.ts).
import { classifyAiError, type AiErrorClass } from './ai-error-classify';
import type { TryFailure } from './http-retry';

// What one row came to.
export type RowOutcome =
  | { kind: 'done' }                                          // its answer was written
  // its ❌ was written; maybeBilled: an AI call that may be billed with no cost Cubex saw (ai-row-outcome.ts)
  // account: the account's side (a refused key, no credits, a model that's gone), which stops the run at once
  | { kind: 'failed'; message: string; provider: boolean; account?: boolean; maybeBilled?: boolean }
  // a stop: nothing written; maybeBilled: its AI call was cut off and may still be billed, as a failed one's;
  // webEngine: OpenRouter's words refusing the run's web fetch engine (lib/web-engine-refusal.ts), so the run pauses
  | { kind: 'dropped'; maybeBilled?: boolean; webEngine?: string };

export const DONE: RowOutcome = { kind: 'done' };
export const DROPPED: RowOutcome = { kind: 'dropped' };

export interface Tripped { rows: number; last: string; account: boolean }

export class RunBreaker {
  private streak = 0;
  private last = '';
  private account = false;
  // accountLimit: failures in a row, one of them on the account's side, that stop it (RUN_BREAKER_ACCOUNT_FAILURES).
  constructor(private readonly limit: number, private readonly accountLimit = 1) {}

  record(outcome: RowOutcome): void {
    if (outcome.kind === 'dropped') return;
    if (outcome.kind === 'failed' && outcome.provider) {
      this.streak++;
      this.last = outcome.message;
      if (outcome.account) this.account = true;
      return;
    }
    this.streak = 0;
    this.account = false;
  }

  // Once the run should stop: how many failed in a row, the last error, and whether the account's side failed.
  get tripped(): Tripped | null {
    if (this.account && this.streak >= Math.min(this.accountLimit, this.limit)) {
      return { rows: this.streak, last: this.last, account: true };
    }
    return this.streak < this.limit ? null : { rows: this.streak, last: this.last, account: false };
  }

  // After a wait (lib/run-brake-waits.ts), rows count afresh.
  reset(): void { this.streak = 0; this.account = false; }
}

// What a run the brake stopped says (never starting with "Paused": the grid's toast adds that). waited: the waits it
// sat out first, in words ("30 s, 2 min and 4.5 min"), or none.
export function brakeMessage(t: Tripped, autorun: boolean, waited = ''): string {
  const then = autorun ? 'so this auto-run stopped; it tries again in a few minutes'
    : 'so the run paused. Resume once it works again: the rows not run yet go on';
  if (t.account) {
    return `The provider refused the account or its key, ${then}. Last error: ${t.last}`.slice(0, 500);
  }
  const after = waited ? `, even after waiting ${waited},` : ',';
  return `${t.rows} rows in a row failed on the provider's side${after} ${then}. Last error: ${t.last}`.slice(0, 500);
}

const PROVIDER_SIDE: ReadonlySet<AiErrorClass> = new Set(['retryable', 'configuration', 'concurrency']);
export const aiProviderSide = (message: string): boolean => PROVIDER_SIDE.has(classifyAiError(message));

// An AI row's error on the account's side, by the status OpenRouter answered (never by the words, which can quote a
// row's own text or a page's): 401, a key it refuses; 402, no credits (not its in-flight budget, which frees up).
export function aiAccountError(error: unknown, message: string): boolean {
  const s = (error as { status?: unknown } | null)?.status;
  return s === 401 || (s === 402 && classifyAiError(message) !== 'concurrency');
}
// An HTTP API row's refused key: 401, or 407 (the proxy's), when the request's host and headers are the same for
// every row (fixed): a host or a header filled from the row can be refused for that row alone. A 403 can be about one
// record, so it counts in a row.
export const httpAccountSide = (failure: TryFailure, fixed: boolean): boolean =>
  fixed && failure.kind === 'status' && (failure.status === 401 || failure.status === 407);
// Whether a request's host and headers are the same for every row (no {{column}} in them).
export function fixedTarget(c: { url: string; headers?: Record<string, string> }): boolean {
  const rest = c.url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const host = rest.split(/[/?#]/, 1)[0];
  return !host.includes('{{') && !Object.values(c.headers ?? {}).some(v => v.includes('{{'));
}

// An HTTP API row's last try: no answer, a rejected key, too many requests, a server error.
export function httpProviderSide(failure: TryFailure): boolean {
  if (failure.kind === 'network') return true;
  if (failure.kind !== 'status') return false;
  const s = failure.status;
  return s === 401 || s === 403 || s === 407 || s === 429 || (s >= 500 && s <= 599);
}
