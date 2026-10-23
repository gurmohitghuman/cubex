// The pieces an AI or HTTP API run's row loop shares (services/ai-runner-lifecycle.ts,
// services/http-runner.ts): waiting for a slot without missing a stop, the
// beat that tells the stalled-run sweep the loop is alive, and how a run that
// stopped itself says why.
import { db } from './db';
import { RUN_HEARTBEAT_MS, RUN_STOP_POLL_MS } from './constants';

// A full pool waits for one row to settle, or RUN_STOP_POLL_MS, whichever is
// first, so the loop sees a pause or cancel while every row is still out. One
// fresh promise per wait, never Promise.race over the rows: each race hangs a
// reaction on every row still out.
export function slotWaiter() {
  let wake: (() => void) | null = null;
  return {
    // A row settled.
    settled(): void { const w = wake; wake = null; w?.(); },
    settledOrTick(): Promise<void> {
      return new Promise(resolve => {
        // Kept referenced: it may be all that keeps a worker's loop alive while it waits.
        const timer = setTimeout(() => { wake = null; resolve(); }, RUN_STOP_POLL_MS);
        wake = () => { clearTimeout(timer); resolve(); };
      });
    },
  };
}

// While the loop waits on its rows, updated_at moves at least every
// RUN_HEARTBEAT_MS (a row finishing moves it too), while the run is still ours.
export function runHeartbeat(table: 'ai_runs' | 'http_runs', runId: string, generation: number): () => void {
  const beat = db.prepare(`UPDATE ${table} SET updated_at = datetime('now')
    WHERE id = ? AND status = 'running' AND worker_generation = ?`);
  let last = Date.now();
  return () => {
    if (Date.now() - last < RUN_HEARTBEAT_MS) return;
    last = Date.now();
    beat.run(runId, generation);
  };
}

// Why a run's loop stopped starting rows on its own: its access token's spend
// cap, its provider failing row after row (lib/run-breaker.ts), or a database
// that can't be written (lib/storage-failure.ts).
export type LoopEnd =
  | { reason: 'token_cap'; message: null }
  | { reason: 'provider_errors'; message: string }
  | { reason: 'storage'; message: string };

export const storageEnd = (error: unknown): LoopEnd => ({
  reason: 'storage',
  message: `Results couldn't be saved (${error instanceof Error ? error.message : 'a write failed'}), so the run `
    + 'stopped sending calls. Free some disk space, then resume it.',
});

// The run paused itself (CAS on running + its generation, so a person's
// pause, cancel or resume wins), rows still ⏳; a resume clears the reason.
// A database that can't be written may refuse this too: the run stays
// running then, and the stalled-run sweep picks it up once it can be written.
export function pauseItself(table: 'ai_runs' | 'http_runs', runId: string, generation: number, end: LoopEnd): void {
  try {
    db.prepare(`UPDATE ${table} SET status = 'paused', pause_reason = ?, error_message = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'running' AND worker_generation = ?`).run(end.reason, end.message, runId, generation);
  } catch (error) {
    console.error(`Pausing run ${runId} (${end.reason}) failed:`, error instanceof Error ? error.message : error);
  }
}
