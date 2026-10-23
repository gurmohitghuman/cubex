// What an AI run's row (ai-row.ts, ai-row-multi.ts) comes to, for the runner's
// brake (lib/run-breaker.ts): its call has a hard deadline, a stop drops it, a
// database that can't be written stops the run, anything else is its ❌.
import { callDeadline, deadlineWords, type CallDeadline } from '../lib/call-deadline';
import { AI_CALL_DEADLINE_MS } from '../lib/constants';
import { aiProviderSide, type RowOutcome } from '../lib/run-breaker';
import { isStorageFailure } from '../lib/storage-failure';

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

export const failedRow = (message: string): RowOutcome =>
  ({ kind: 'failed', message, provider: aiProviderSide(message) });
