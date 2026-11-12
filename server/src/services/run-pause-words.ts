// Why a run paused itself, in plain words, read from the run's own row: the sheet's notice beside Resume
// (GET /ai/runs and GET /http/runs) and get_run_status show them. Every pause a run makes itself saves its
// reason in pause_reason and its words in error_message (lib/run-pool.ts, services/stalled-runs.ts, the
// enrichment and waterfall runners, the list source), and a resume clears both (services/run-lifecycle.ts).
// A person's pause saves no reason, so it has no words. An AI or HTTP API run stopped by its access token's
// spend cap saves no words either: they're worked out from the token when read, so a cap raised since says so.
import { spendCapRefusal } from './token-spend';

const CAP_RAISED = "Its access token's spend cap was raised: resume the run to go on.";

// A run paused at its access token's spend cap: what the cap is now, or that it was raised.
export const tokenCapWords = (userId: string, tokenId: string | null | undefined): string =>
  spendCapRefusal(userId, tokenId) ?? CAP_RAISED;

interface PausedRow {
  status: string; pause_reason?: string | null; error_message?: string | null;
  user_id?: string; access_token_id?: string | null;
}

// The words of a run that paused itself; null for any other run.
export function pauseWords(r: PausedRow): string | null {
  if (r.status !== 'paused' || !r.pause_reason) return null;
  if (r.error_message) return r.error_message;
  return r.pause_reason === 'token_cap' && r.user_id ? tokenCapWords(r.user_id, r.access_token_id) : null;
}

// The run list with pause_message on each run that paused itself (one SELECT * row each).
export const withPauseWords = <T extends PausedRow>(runs: T[]): Array<T & { pause_message?: string }> =>
  runs.map(r => {
    const words = pauseWords(r);
    return words === null ? r : { ...r, pause_message: words };
  });
