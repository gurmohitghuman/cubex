import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { db } from './db';

// Idempotency for run_ai_column / run_http_enrichment, on the same
// data_operation_ledger table transfer_rows uses (migration 040). A run returns
// a run_id immediately and then executes asynchronously, so — unlike transfer —
// the "result" is known at START, not after. Contract: retrying with the SAME
// key + SAME arguments returns the ORIGINAL run_id (replayed:true) instead of
// starting a second run; the same key with DIFFERENT arguments is a conflict.
//
// Race note: two concurrent identical calls could both miss the ledger and both
// try to start. The dangerous outcome (a duplicate BILLING run on one column) is
// already prevented by the start path's active-run conflict guard (a second run
// on the same column 409s); this ledger turns a later retry into a clean replay
// and makes retry-after-failure return the same run_id. We write the ledger only
// AFTER a successful start, keyed UNIQUE(user_id, idempotency_key).

export interface RunLedgerResult {
  run_id: string;
  [k: string]: unknown;
}

function canonicalHash(kind: string, config: Record<string, unknown>): string {
  // Sort object keys + array values so equivalent requests hash identically.
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b)).map(([k, val]) => [k, norm(val)]));
    }
    return v;
  };
  return crypto.createHash('sha256').update(JSON.stringify({ kind, config: norm(config) })).digest('hex');
}

// Read: null (proceed), {replay} (return the stored run), or {conflict} (key
// reused with different args).
export function readRunLedger(
  userId: string, key: string, hash: string,
): { replay: RunLedgerResult } | { conflict: true } | null {
  const row = db.prepare(
    'SELECT request_hash, result_json FROM data_operation_ledger WHERE user_id = ? AND idempotency_key = ?',
  ).get(userId, key) as { request_hash: string; result_json: string } | undefined;
  if (!row) return null;
  if (row.request_hash !== hash) return { conflict: true };
  return { replay: JSON.parse(row.result_json) as RunLedgerResult };
}

// Write after a successful start. INSERT OR IGNORE so a concurrent winner's row
// stands (we don't clobber it); the caller's own run_id is still valid to return.
// Prunes the per-user ledger to the most recent 1000 (shared with transfer).
export function writeRunLedger(
  userId: string, key: string, hash: string, kind: 'ai_run' | 'http_run', result: RunLedgerResult,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO data_operation_ledger
      (id, user_id, idempotency_key, operation_kind, request_hash, result_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(uuidv4(), userId, key, kind, hash, JSON.stringify(result));
  db.prepare(`
    DELETE FROM data_operation_ledger WHERE id IN (
      SELECT id FROM data_operation_ledger WHERE user_id = ?
      ORDER BY created_at DESC LIMIT 25 OFFSET 1000
    )
  `).run(userId);
}

export function runRequestHash(kind: 'ai_run' | 'http_run', config: Record<string, unknown>): string {
  return canonicalHash(kind, config);
}
