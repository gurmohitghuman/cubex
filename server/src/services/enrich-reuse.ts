// Reusing found answers across runs and sheets. Before a row calls treg it
// looks for a found answer to the same lookup (lib/enrich-reuse-key.ts) that
// any run of the account stored in the last N days (Settings, 30 by default,
// 0 turns it off; a run set to "Always call again" never looks). That's one
// read of idx_http_results_reuse, never a scan of stored answers. The row then
// fills from that answer at $0: no call, no ledger row, nothing on the daily
// limit. Only answers from real calls carry a key, so an answer's age is
// always that of the call that bought it, however often it was reused since.
// Runs in worker threads too (plain DB reads and writes).
import { db } from '../lib/db';
import { ENRICH_REUSE_DAYS_DEFAULT, ENRICH_REUSE_DAYS_MAX } from '../lib/constants';
import { nowDate } from '../lib/clock';
import { parseStored, readStored } from '../lib/answer-store';
import type { AnswerNotes, ReusedFrom } from '../lib/enrich-reuse-key';
import { ensureSettingsRow } from './treg-key';

// The time format of http_results.answered_at: ISO with a space, like datetime('now').
export const answerTime = (d: Date): string => d.toISOString().replace('T', ' ').slice(0, 19);

// A missing settings row means the default.
export function getReuseDays(userId: string): number {
  const row = db.prepare('SELECT enrich_reuse_days FROM settings WHERE user_id = ?')
    .get(userId) as { enrich_reuse_days: number } | undefined;
  return row ? Math.max(0, Math.min(ENRICH_REUSE_DAYS_MAX, row.enrich_reuse_days)) : ENRICH_REUSE_DAYS_DEFAULT;
}

export function setReuseDays(userId: string, days: number): void {
  db.transaction(() => {
    ensureSettingsRow(userId);
    db.prepare("UPDATE settings SET enrich_reuse_days = ?, updated_at = datetime('now') WHERE user_id = ?")
      .run(days, userId);
  })();
}

// The oldest answer a row may still reuse (null: reuse is off).
export function reuseSince(days: number, now: Date = nowDate()): string | null {
  return days > 0 ? answerTime(new Date(now.getTime() - days * 86_400_000)) : null;
}

export interface FoundAnswer { body: unknown; from: ReusedFrom; notes: AnswerNotes }

// The newest found answer to this lookup since `since` from another run, as
// treg gave it (plus the earlier row's _cubex notes; a pruned answer has lost
// its raw part only). A run's own rows share a lookup through runStep instead
// ("same lookup as row N", services/enrich-step.ts).
export function findReusable(userId: string, key: string, since: string, runId: string): FoundAnswer | null {
  const r = db.prepare(`
    SELECT r.response_data AS data, r.run_id AS runId, r.answered_at AS at, h.sheet_id AS sheetId
    FROM http_results r JOIN http_runs h ON h.id = r.run_id
    WHERE r.user_id = ? AND r.reuse_key = ? AND r.answered_at >= ? AND r.run_id != ?
    ORDER BY r.answered_at DESC LIMIT 1
  `).get(userId, key, since, runId) as { data: string | null; runId: string; at: string; sheetId: string } | undefined;
  const stored = r ? parseStored(r.data) : null;
  if (!r || stored === null) return null;
  const read = readStored(stored);
  return {
    body: read.body, from: { run_id: r.runId, sheet_id: r.sheetId, answered_at: r.at },
    notes: { trimmedPaths: read.trimmedPaths, prunedAt: read.prunedAt },
  };
}

// Whether any found answer to this lookup is young enough (the estimate's
// count: the index alone answers it). whole: the run reads the raw part, so
// only an answer that kept all of it counts (reading it costs a row read; the
// worker checks each path exactly, so this count may only be lower).
export function hasReusable(userId: string, key: string, since: string, whole = false): boolean {
  if (!whole) {
    return !!db.prepare(`SELECT 1 FROM http_results WHERE user_id = ? AND reuse_key = ? AND answered_at >= ? LIMIT 1`)
      .get(userId, key, since);
  }
  return !!db.prepare(`SELECT 1 FROM http_results WHERE user_id = ? AND reuse_key = ? AND answered_at >= ?
    AND json_extract(response_data, '$."$prunedAt"') IS NULL AND json_extract(response_data, '$."$trimmedPaths"') IS NULL
    LIMIT 1`).get(userId, key, since);
}

// Counted in the transaction that writes the reused row's result.
export function noteReusedRow(runId: string, userId: string): void {
  db.prepare(`INSERT INTO enrich_run_reuse (run_id, user_id, reused_rows) VALUES (?, ?, 1)
    ON CONFLICT(run_id) DO UPDATE SET reused_rows = reused_rows + 1`).run(runId, userId);
}

export function reusedRows(runId: string, userId: string): number {
  return (db.prepare('SELECT reused_rows FROM enrich_run_reuse WHERE run_id = ? AND user_id = ?')
    .pluck().get(runId, userId) as number | undefined) ?? 0;
}
