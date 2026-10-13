import { APIConnectionError, APIConnectionTimeoutError, APIError } from 'openai';
import {
  AI_CONNECT_RETRY_DELAY_MS, AI_IN_FLIGHT_RETRIES, AI_IN_FLIGHT_DEFAULT_WAIT_MS, AI_IN_FLIGHT_MAX_WAIT_MS,
} from '../lib/constants';

// The two narrow exceptions to the maxRetries:0 cost guard. The first (see getOpenRouterClient
// in openrouter.ts). That guard exists because with stream:false a read timeout
// lands AFTER the provider fully generated (and billed), so a blind retry
// double-charges. But a pre-response ECONNRESET is different: the shared
// keep-alive agent (openrouter-agent.ts) handed out a socket that
// OpenRouter/Cloudflare had already closed, and the request died on the wire —
// nothing was generated, nothing was billed. Under wave dispatch this fails a
// CONTIGUOUS BLOCK of rows at once ("Connection error." cells), which users
// read as a broken run. Retrying exactly this signature once is free.
// The second is OpenRouter's in-flight credit budget (inFlightWaitMs below).
//
// Deliberately NOT retried (each could follow a billed generation, or signals a
// real problem a retry would mask):
//   - APIConnectionTimeoutError — the original cost-guard case
//   - other transport failures (ENOTFOUND, TLS, EPIPE, generic hang-up)
//   - every other HTTP-status error (401/429/5xx, a 402 for an empty balance)
// Empirically verified (openai@4.104.0 + httpAgent → node-fetch shim): a
// server-side RST surfaces as APIConnectionError with cause.code === 'ECONNRESET'
// directly on the cause (a FetchError), not nested deeper.
function isStaleSocketError(error: unknown): boolean {
  if (!(error instanceof APIConnectionError)) return false;
  if (error instanceof APIConnectionTimeoutError) return false;
  return (error as { cause?: { code?: string } }).cause?.code === 'ECONNRESET';
}

// Transport-level cause code (e.g. 'ECONNRESET', 'ETIMEDOUT') of a connection
// error, for appending to the persisted row error. The SDK's message is a bare
// "Connection error." — without the code we can't tell from a user report
// whether the retry classifier missed or something new broke.
export function connectionCauseCode(error: unknown): string | null {
  if (!(error instanceof APIConnectionError)) return null;
  const code = (error as { cause?: { code?: string } }).cause?.code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

// OpenRouter's machine reason for a refusal (error.metadata.reason, e.g.
// in_flight_budget_exhausted), when it sent one.
function openRouterReason(error: unknown): string | null {
  if (!(error instanceof APIError)) return null;
  const reason = (error.error as { metadata?: { reason?: unknown } } | undefined)?.metadata?.reason;
  return typeof reason === 'string' && /^[a-z0-9_]{1,64}$/.test(reason) ? reason : null;
}

// What a persisted row error carries in brackets: the transport code of a
// connection error, or OpenRouter's reason for a refusal, so
// lib/ai-error-classify.ts can tell refusals with the same status apart.
export function errorCauseCode(error: unknown): string | null {
  return connectionCauseCode(error) ?? openRouterReason(error);
}

// OpenRouter's in-flight credit budget: every running call holds an estimate of
// its cost, and a call that would pass the balance is refused with 402, reason
// in_flight_budget_exhausted, and a Retry-After. The refusal comes before the
// call runs (nothing generated, nothing billed) and clears as running calls
// settle (https://openrouter.ai/docs/api_reference/limits). The words are the
// fallback only for a body without a reason: another budget 402
// (weight_exceeds_budget, one call too big for the balance) never clears by
// waiting. How long to wait, or null for any other error.
export function inFlightWaitMs(error: unknown): number | null {
  if (!(error instanceof APIError) || error.status !== 402) return null;
  const reason = openRouterReason(error);
  if (reason ? reason !== 'in_flight_budget_exhausted' : !/in-flight requests/i.test(error.message)) return null;
  const header = (error.headers as Record<string, string | null | undefined> | undefined)?.['retry-after'];
  const sec = header === null || header === undefined || header.trim() === '' ? NaN : Number(header);
  const ms = Number.isFinite(sec) && sec >= 0 ? sec * 1000 : AI_IN_FLIGHT_DEFAULT_WAIT_MS;
  return Math.min(AI_IN_FLIGHT_MAX_WAIT_MS, Math.max(AI_CONNECT_RETRY_DELAY_MS, ms));
}

// A wait that ends early when the row is aborted.
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

// One OpenRouter call (`send`) with the stale-socket retry (once) and the
// in-flight budget retries (up to AI_IN_FLIGHT_RETRIES, each after its
// Retry-After plus up to a second of jitter, so a whole wave refused at once
// doesn't come back at once). `stopped` is
// the run's generation fence (shouldStop closure): pause/cancel/resume flips DB
// state before the AbortSignal fires, and this row may be mid-backoff when it
// does — so re-check BOTH before sleeping and again before the next call, or
// the retry could spend after the user stopped the run. Rethrowing the
// original error when the fence trips is deliberate: processRow's catch sees
// aborted/shouldStop and drops it as benign, never recording a failure.
export async function withConnectRetry<T>(
  send: () => Promise<T>,
  signal: AbortSignal | undefined,
  stopped: () => boolean,
): Promise<T> {
  let staleLeft = 1;
  let inFlightLeft = AI_IN_FLIGHT_RETRIES;
  for (;;) {
    try {
      return await send();
    } catch (error) {
      const stale = staleLeft > 0 && isStaleSocketError(error);
      const inFlight = inFlightLeft > 0 ? inFlightWaitMs(error) : null;
      if ((!stale && inFlight === null) || signal?.aborted || stopped()) throw error;
      if (stale) staleLeft--; else inFlightLeft--;
      await pause(stale ? AI_CONNECT_RETRY_DELAY_MS : (inFlight as number) + Math.random() * 1000, signal);
      if (signal?.aborted || stopped()) throw error;
    }
  }
}
