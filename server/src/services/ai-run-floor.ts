// The least spend limit an AI run with one can go on with, in micro-dollars
// as its worker counts them (services/ai-spend-gate.ts). A resume is checked
// against it (services/ai-run-limit.ts); the app's "Raise the spend limit"
// dialog, get_run_status and GET /v1/ai-runs/:id (resume_least_usd) show it.
import { db } from '../lib/db';
import { micro } from '../lib/cost-ceiling';
import { runSpentUsd } from './ai-spend-gate';

export interface LimitRow {
  status: string; pause_reason: string | null; error_message: string | null; column_name: string | null;
  spend_limit_usd: number | null; spend_cut_off_micro: number; spend_next_row_micro: number | null;
  total_rows: number; processed_rows: number;
}
export const limitRow = (runId: string, userId: string) => db.prepare(`SELECT status, pause_reason, error_message,
  column_name, spend_limit_usd, spend_cut_off_micro, spend_next_row_micro, total_rows, processed_rows
  FROM ai_runs WHERE id = ? AND user_id = ?`).get(runId, userId) as LimitRow | undefined;

// least: the lowest limit it can go on with. Spending only grows, so a run
// its limit stopped (pause_reason spend_limit) needs what it spent, plus what
// its cut-off calls hold (they may be billed), plus its next row's most (a
// row counts as at least a micro-dollar), and more than the old limit; any
// other run with a limit, more than what it spent and holds for those calls.
export interface Floor { spent: number; cutOff: number; nextRow: number | null; least: number }
type FloorRow = Pick<LimitRow, 'pause_reason' | 'spend_limit_usd' | 'spend_cut_off_micro' | 'spend_next_row_micro'>;
export function floorOf(runId: string, userId: string, r: FloorRow): Floor {
  const spent = Math.round(runSpentUsd(runId, userId) * 1e6), cutOff = r.spend_cut_off_micro;
  if (r.pause_reason !== 'spend_limit' || r.spend_limit_usd === null) {
    return { spent, cutOff, nextRow: null, least: spent + cutOff + 1 };
  }
  const nextRow = r.spend_next_row_micro;
  const least = Math.max(spent + cutOff + Math.max(nextRow ?? 1, 1), micro(r.spend_limit_usd) + 1);
  return { spent, cutOff, nextRow, least };
}

const UNFINISHED = new Set(['pending', 'running', 'paused']);
// What a run summary says (services/run-status.ts): a run with a limit that
// isn't finished, the least spend_limit_usd a resume takes, exact; else nothing.
export function resumeLeastPart(runId: string, userId: string, r: FloorRow & { status: string })
  : { resume_least_usd?: number } {
  if (r.spend_limit_usd === null || r.spend_limit_usd === undefined || !UNFINISHED.has(r.status)) return {};
  return { resume_least_usd: floorOf(runId, userId, r).least / 1e6 };
}
