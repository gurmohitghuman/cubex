// What an AI run's row (ai-row.ts, ai-row-multi.ts) comes to, for the runner's
// brake (lib/run-breaker.ts) and its spend limit (ai-spend-gate.ts): its call
// has a hard deadline, a stop drops it, a database that can't be written stops
// the run, anything else is its ❌, which says whether the call may be billed
// with no cost Cubex saw.
import { APIConnectionError, APIConnectionTimeoutError, APIError } from 'openai';
import { callDeadline, deadlineWords, type CallDeadline } from '../lib/call-deadline';
import { AI_CALL_DEADLINE_MS, AI_RESET_MAYBE_BILLED_MS } from '../lib/constants';
import { aiProviderSide, type RowOutcome } from '../lib/run-breaker';
import { isStorageFailure } from '../lib/storage-failure';
import { FailedCallError, type ModelCall } from './ai-model-call';
import { connectionCauseCode } from './openrouter-retry';

// The row's call ends when the run stops or the deadline passes.
export const aiCallDeadline = (signal: AbortSignal | undefined): CallDeadline =>
  callDeadline(AI_CALL_DEADLINE_MS, signal);

export const AI_TIMEOUT_MESSAGE = `No answer from the model within ${deadlineWords(AI_CALL_DEADLINE_MS)} `
  + '(timed out). Re-run the row to try again.';

// The call ended because the run stopped (a pause, a cancel, a resume taking
// over), not because of the row: nothing is written.
export function stoppedCall(error: unknown, deadline: CallDeadline, signal: AbortSignal | undefined): boolean {
  if (deadline.timedOut()) return false;
  const name = (error as { name?: string })?.name;
  return name === 'AbortError' || name === 'APIUserAbortError' || signal?.aborted === true;
}

// Nothing can be saved: thrown on to the runner, which stops sending calls
// (each one is paid before its result is written).
export function throwIfStorage(error: unknown): void {
  if (isStorageFailure(error)) throw error;
}

export const failedRow = (message: string, maybeBilled = false): RowOutcome =>
  ({ kind: 'failed', message, provider: aiProviderSide(message), ...(maybeBilled ? { maybeBilled } : {}) });

// Transport failures that come before anything reaches the provider: no
// address, no connection. A connection reset is the stale keep-alive socket
// openrouter-retry.ts retries (the request died on the wire) only when it
// comes at once; one that comes AI_RESET_MAYBE_BILLED_MS or more after a try
// went out (a proxy's idle timeout during a long answer) may follow a billed
// answer.
const NEVER_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);
const isReset = (error: unknown) => error instanceof APIConnectionError
  && !(error instanceof APIConnectionTimeoutError) && connectionCauseCode(error) === 'ECONNRESET';

// The tries of one call (withConnectRetry calls send once a try), timed:
// lateReset says whether any try was reset that long after it went out. Such
// a try may be billed even when a try after it fails otherwise.
export function timedTries<T>(send: () => Promise<T>): { send: () => Promise<T>; lateReset: () => boolean } {
  let late = false;
  return {
    send: async () => {
      const at = Date.now();
      try { return await send(); } catch (error) {
        if (isReset(error) && Date.now() - at >= AI_RESET_MAYBE_BILLED_MS) late = true;
        throw error;
      }
    },
    lateReset: () => late,
  };
}

// Whether a failed row's call may be billed although no cost came back. With
// stream:false the provider generates (and bills) the whole answer before it
// sends it, so a call that was sent and then gave nothing back may be paid
// for: cut off at the row's deadline (an abort), the SDK's "Request timed
// out." (no headers within AI_REQUEST_TIMEOUT_MS), an answer that broke off
// or couldn't be read, a connection lost after it was sent, a try reset late
// (lateReset). Not: a call never sent, one that came back (its cost is
// recorded, failed responses included), an error status from OpenRouter (a
// refusal is not billed; also when the deadline passed while waiting to try
// again), a connection that never reached it, one reset at once. The error is
// the last try's own.
export function callMayBeBilled(
  error: unknown, a: { sent: boolean; call: ModelCall | null; lateReset?: boolean },
): boolean {
  if (!a.sent) return false;
  if (a.lateReset) return true;
  if (a.call || error instanceof FailedCallError) return false;
  if (error instanceof APIConnectionTimeoutError) return true;
  if (isReset(error)) return false;
  if (error instanceof APIConnectionError) return !NEVER_SENT.has(connectionCauseCode(error) ?? '');
  return !(error instanceof APIError && typeof error.status === 'number');
}
