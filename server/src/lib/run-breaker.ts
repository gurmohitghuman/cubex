// The brake on an AI or HTTP API run: rows failing in a row for a reason on
// the provider's or the account's side (no answer, 5xx, 429 after its retries,
// a rejected key, no credits, a model that's gone) pause the run once there
// are RUN_BREAKER_FAILURES of them, so an outage leaves the rest of the sheet
// ⏳ for Resume instead of writing ❌ into every row. A row the provider
// answered, even with an error about the row itself, resets the count.
import { classifyAiError, type AiErrorClass } from './ai-error-classify';
import type { TryFailure } from './http-retry';

// What one row came to.
export type RowOutcome =
  | { kind: 'done' }                                          // its answer was written
  | { kind: 'failed'; message: string; provider: boolean }    // its ❌ was written
  | { kind: 'dropped' };                                      // a stop: nothing written

export const DONE: RowOutcome = { kind: 'done' };
export const DROPPED: RowOutcome = { kind: 'dropped' };

export class RunBreaker {
  private streak = 0;
  private last = '';
  constructor(private readonly limit: number) {}

  record(outcome: RowOutcome): void {
    if (outcome.kind === 'dropped') return;
    if (outcome.kind === 'failed' && outcome.provider) {
      this.streak++;
      this.last = outcome.message;
      return;
    }
    this.streak = 0;
  }

  // Once the run should stop: how many failed in a row, and the last error.
  get tripped(): { rows: number; last: string } | null {
    return this.streak < this.limit ? null : { rows: this.streak, last: this.last };
  }
}

// What a run the brake stopped says (never starting with "Paused": the grid's toast adds that).
export function brakeMessage(t: { rows: number; last: string }, autorun: boolean): string {
  const then = autorun ? 'so this auto-run stopped; it tries again in a few minutes'
    : 'so the run paused. Resume once it works again: the rows not run yet go on';
  return `${t.rows} rows in a row failed on the provider's side, ${then}. Last error: ${t.last}`.slice(0, 500);
}

const PROVIDER_SIDE: ReadonlySet<AiErrorClass> = new Set(['retryable', 'configuration', 'concurrency']);
export const aiProviderSide = (message: string): boolean => PROVIDER_SIDE.has(classifyAiError(message));

// An HTTP API row's last try: no answer, a rejected key, too many requests, a server error.
export function httpProviderSide(failure: TryFailure): boolean {
  if (failure.kind === 'network') return true;
  if (failure.kind !== 'status') return false;
  const s = failure.status;
  return s === 401 || s === 403 || s === 407 || s === 429 || (s >= 500 && s <= 599);
}
