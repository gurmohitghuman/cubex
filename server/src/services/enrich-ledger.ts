// The enrichment ledger: every treg call, written as soon as its answer
// arrives and BEFORE the row's result, so a paused, cancelled or failed row
// still counts what it cost. Today's counter (enrich_daily_spend) moves in the
// same transaction, so the daily limit is one row read and always equals the
// ledger's sum for the day. Runs in worker threads too (a plain DB write).
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import type { TregMeta } from '../lib/treg-meta';
import { utcDay } from './treg-key';

export interface LedgerCall {
  userId: string; sheetId: string; runId: string; rowId: string | null; statusColumn: string | null;
  toolId: string; attempt: string; idempotencyKey: string; httpStatus: number | null;
  tregErrorCode: string | null; tier: string | null; meta: TregMeta;
}

export interface Recorded {
  ledgerMicro: number;   // what this call adds to the ledger, the day and the run
  rowMicro: number;      // what the row's answer cost (a replay counts its first charge)
}

// Writes the call and moves today's counter and the run's spend with it. A
// replay is free, unless the ledger never saw the first charge for its key
// (the answer was lost to a restart, a timeout or a reset): then treg billed
// it once and this is where that charge is recorded.
export function recordCall(c: LedgerCall, now = new Date()): Recorded {
  const day = utcDay(now);
  // ISO with a space, like datetime('now'), so string comparisons agree.
  const at = now.toISOString().replace('T', ' ').slice(0, 19);
  let ledgerMicro = 0;
  db.transaction(() => {
    let cost = c.meta.costMicro;
    if (c.meta.replay && c.meta.originalCostMicro && !db.prepare(`
      SELECT 1 FROM enrichment_calls WHERE user_id = ? AND run_id = ? AND row_id IS ? AND idempotency_key = ? AND cost_micro > 0 LIMIT 1
    `).get(c.userId, c.runId, c.rowId, c.idempotencyKey)) cost = c.meta.originalCostMicro;
    ledgerMicro = cost ?? 0;
    db.prepare(`
      INSERT INTO enrichment_calls (id, user_id, sheet_id, run_id, row_id, status_column, tool_id, attempt, idempotency_key,
        call_id, cost_micro, original_cost_micro, http_status, treg_error, served_by, served_via, tier, cache_hit, replay, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(), c.userId, c.sheetId, c.runId, c.rowId, c.statusColumn, c.toolId, c.attempt, c.idempotencyKey,
      c.meta.callId, cost, c.meta.originalCostMicro, c.httpStatus,
      c.meta.tregError ? (c.tregErrorCode ?? '1') : null, c.meta.servedBy, c.meta.servedVia, c.tier,
      c.meta.cacheHit ? 1 : 0, c.meta.replay ? 1 : 0, at,
    );
    if (ledgerMicro > 0) {
      db.prepare(`
        INSERT INTO enrich_daily_spend (user_id, day, spent_micro) VALUES (?, ?, ?)
        ON CONFLICT(user_id, day) DO UPDATE SET spent_micro = spent_micro + excluded.spent_micro
      `).run(c.userId, day, ledgerMicro);
      db.prepare('UPDATE http_runs SET spent_micro = spent_micro + ? WHERE id = ? AND user_id = ?').run(ledgerMicro, c.runId, c.userId);
    }
  }).immediate();
  const rowMicro = c.meta.replay ? (c.meta.originalCostMicro ?? ledgerMicro) : ledgerMicro;
  return { ledgerMicro, rowMicro };
}

// What a run has spent so far (migration 012's counter, moved with the ledger).
export function runSpentMicro(runId: string, userId: string): number {
  const r = db.prepare('SELECT spent_micro FROM http_runs WHERE id = ? AND user_id = ?').get(runId, userId) as { spent_micro: number } | undefined;
  return r?.spent_micro ?? 0;
}

// Was this call id already recorded under this key? treg replays an answer
// with its first call id, so a refusal seen twice under one key is treg
// answering from its store, not refusing again.
export function seenCallId(userId: string, runId: string, rowId: string | null, key: string, callId: string | null): boolean {
  if (!callId) return false;
  return !!db.prepare(`SELECT 1 FROM enrichment_calls WHERE user_id = ? AND run_id = ? AND row_id IS ? AND idempotency_key = ? AND call_id = ? LIMIT 1`)
    .get(userId, runId, rowId, key, callId);
}

// How many keys this row's step has used ("f1", "f1.2"…), for the next one.
export function keysUsed(userId: string, runId: string, rowId: string | null, attempt: string): number {
  const r = db.prepare(`
    SELECT COUNT(DISTINCT idempotency_key) AS n FROM enrichment_calls
    WHERE user_id = ? AND run_id = ? AND row_id IS ? AND (attempt = ? OR attempt LIKE ? ESCAPE '\\')
  `).get(userId, runId, rowId, attempt, `${attempt.replace(/[\\%_]/g, '\\$&')}.%`) as { n: number };
  return r.n;
}
