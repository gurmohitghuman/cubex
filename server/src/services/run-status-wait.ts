// Waits up to `seconds` for a run to change, holding one of the account's long-poll slots. By default any
// progress ends the wait (the waterfall dry run's loop, waterfall-token-dry.ts). statusOnly (MCP get_run_status)
// ends it only when the status changes (the run starts, ends, pauses or fails) or the time is up, so an agent
// following a steady run asks once per wait instead of once per batch of rows.
import { acquireLongPollHold, releaseLongPollHold } from '../lib/long-poll-holds';
import { getAiRunSummary, getHttpRunSummary, RunSummary } from './run-status';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const CHECK_INTERVAL_MS = 1000;

function read(type: 'ai' | 'http', runId: string, userId: string): RunSummary | null {
  return type === 'ai' ? getAiRunSummary(runId, userId) : getHttpRunSummary(runId, userId);
}

export async function waitForRunChange(
  type: 'ai' | 'http',
  runId: string,
  userId: string,
  seconds: number,
  signal?: AbortSignal,
  opts: { statusOnly?: boolean } = {},
): Promise<RunSummary | null> {
  const initial = read(type, runId, userId);
  if (!initial || seconds <= 0 || TERMINAL.has(initial.status)) return initial;
  if (!acquireLongPollHold(userId)) return initial;

  return new Promise(resolve => {
    let finished = false;
    const deadline = Date.now() + seconds * 1000;
    const finish = (value: RunSummary | null) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      signal?.removeEventListener('abort', aborted);
      releaseLongPollHold(userId);
      resolve(value);
    };
    const aborted = () => finish(read(type, runId, userId));
    const timer = setInterval(() => {
      const current = read(type, runId, userId);
      if (!current) return finish(null);
      const progressed = !opts.statusOnly && current.processed_rows !== initial.processed_rows;
      if (current.status !== initial.status || progressed
          || TERMINAL.has(current.status) || Date.now() >= deadline) finish(current);
    }, CHECK_INTERVAL_MS);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}
