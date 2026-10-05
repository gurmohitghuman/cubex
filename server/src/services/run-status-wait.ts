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
      if (current.status !== initial.status || current.processed_rows !== initial.processed_rows
          || TERMINAL.has(current.status) || Date.now() >= deadline) finish(current);
    }, CHECK_INTERVAL_MS);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}
