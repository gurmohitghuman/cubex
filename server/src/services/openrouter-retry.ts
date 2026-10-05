import type OpenAI from 'openai';
import { APIConnectionError, APIConnectionTimeoutError } from 'openai';
import { AI_CONNECT_RETRY_DELAY_MS } from '../lib/constants';

// The ONE narrow exception to the maxRetries:0 cost guard (see getOpenRouterClient
// in openrouter.ts). That guard exists because with stream:false a read timeout
// lands AFTER the provider fully generated (and billed), so a blind retry
// double-charges. But a pre-response ECONNRESET is different: the shared
// keep-alive agent (openrouter-agent.ts) handed out a socket that
// OpenRouter/Cloudflare had already closed, and the request died on the wire —
// nothing was generated, nothing was billed. Under wave dispatch this fails a
// CONTIGUOUS BLOCK of rows at once ("Connection error." cells), which users
// read as a broken run. Retrying exactly this signature once is free.
//
// Deliberately NOT retried (each could follow a billed generation, or signals a
// real problem a retry would mask):
//   - APIConnectionTimeoutError — the original cost-guard case
//   - other transport failures (ENOTFOUND, TLS, EPIPE, generic hang-up)
//   - every HTTP-status error (401/429/5xx)
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

// chat.completions.create with the single stale-socket retry. `stopped` is the
// run's generation fence (shouldStop closure): pause/cancel/resume flips DB
// state before the AbortSignal fires, and this row may be mid-backoff when it
// does — so re-check BOTH before sleeping and again before the second create,
// or the retry could spend after the user stopped the run. Rethrowing the
// original error when the fence trips is deliberate: processRow's catch sees
// aborted/shouldStop and drops it as benign, never recording a failure.
export async function createCompletionWithConnectRetry(
  openai: OpenAI,
  completionArgs: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
  signal: AbortSignal | undefined,
  stopped: () => boolean,
): Promise<OpenAI.Chat.ChatCompletion> {
  try {
    return await openai.chat.completions.create(completionArgs, { signal });
  } catch (error) {
    if (!isStaleSocketError(error) || signal?.aborted || stopped()) throw error;
    await new Promise(resolve => setTimeout(resolve, AI_CONNECT_RETRY_DELAY_MS));
    if (signal?.aborted || stopped()) throw error;
    return await openai.chat.completions.create(completionArgs, { signal });
  }
}
