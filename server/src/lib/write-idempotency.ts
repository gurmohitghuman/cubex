// Idempotency keys for row writes over /api/v1 and MCP (append_rows,
// update_cells and their REST routes), on the ledger run starts and
// transfer_rows use (data_operation_ledger, one key namespace per user). A row
// write's key replays its first answer for IDEMPOTENT_WRITE_TTL_MS (a day);
// after that the key is free again. Every other kind's entry never expires here.
// The read and the write both run inside the caller's one immediate
// transaction (services/rows-write-keyed.ts), so two calls with one key, from
// two connections at once, write once: the second waits for the first's lock
// and then finds its entry.
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { db } from './db';
import {
  IDEMPOTENT_WRITE_KEYS_MAX, IDEMPOTENT_WRITE_PRUNE_ROWS, IDEMPOTENT_WRITE_TTL_MS,
} from './api-v1-constants';

export const WRITE_KINDS = ['rows_append', 'cells_update', 'cells_update_batch'] as const;
export type WriteKind = typeof WRITE_KINDS[number];
// For `operation_kind IN (...)`: constants only, never user input.
export const WRITE_KINDS_SQL = WRITE_KINDS.map(k => `'${k}'`).join(', ');

// JSON with every object's keys sorted by code unit (never by locale, which
// can differ between machines); arrays keep their order. Null-prototype
// objects, so a column named "__proto__" stays an ordinary key.
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (!v || typeof v !== 'object') return v;
    const out: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      out[k] = norm((v as Record<string, unknown>)[k]);
    }
    return out;
  };
  return JSON.stringify(norm(value));
}

export function writeRequestHash(kind: WriteKind, args: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(canonicalJson({ kind, args })).digest('hex');
}

// SQLite's datetime('now') format, UTC.
const cutoff = (now: number) =>
  new Date(now - IDEMPOTENT_WRITE_TTL_MS).toISOString().replace('T', ' ').slice(0, 19);

export type LedgerRead<T> = { replay: T } | { conflict: true } | null;

// Inside the write's transaction: null (go ahead), the stored answer to
// replay, or a conflict (the key was used with other arguments, or by another
// kind of call). `sameCall` checks what the hash can't (a one-row update's
// optional sheet_id against the row's sheet). An expired row-write entry is
// deleted here, so the key can be stored again in the same transaction.
export function readWriteLedger<T>(
  userId: string, key: string, hash: string, sameCall?: (stored: T) => boolean, now = Date.now(),
): LedgerRead<T> {
  const row = db.prepare(`SELECT id, operation_kind, request_hash, result_json, created_at
    FROM data_operation_ledger WHERE user_id = ? AND idempotency_key = ?`).get(userId, key) as {
      id: string; operation_kind: string; request_hash: string; result_json: string; created_at: string;
    } | undefined;
  if (!row) return null;
  if ((WRITE_KINDS as readonly string[]).includes(row.operation_kind) && row.created_at < cutoff(now)) {
    db.prepare('DELETE FROM data_operation_ledger WHERE id = ?').run(row.id);
    return null;
  }
  if (row.request_hash !== hash) return { conflict: true };
  const stored = JSON.parse(row.result_json) as T;
  return sameCall && !sameCall(stored) ? { conflict: true } : { replay: stored };
}

// In the same transaction, after the rows were written. A user past
// IDEMPOTENT_WRITE_KEYS_MAX entries loses its oldest row-write keys (found
// through the (user_id, created_at) index alone; run and transfer entries keep
// their own rule).
export function writeWriteLedger(userId: string, key: string, kind: WriteKind, hash: string, stored: unknown): void {
  db.prepare(`INSERT INTO data_operation_ledger
      (id, user_id, idempotency_key, operation_kind, request_hash, result_json)
    VALUES (?, ?, ?, ?, ?, ?)`).run(uuidv4(), userId, key, kind, hash, JSON.stringify(stored));
  const edge = db.prepare(`SELECT created_at FROM data_operation_ledger WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 1 OFFSET ?`).pluck().get(userId, IDEMPOTENT_WRITE_KEYS_MAX) as string | undefined;
  if (edge === undefined) return;
  db.prepare(`DELETE FROM data_operation_ledger WHERE id IN (SELECT id FROM data_operation_ledger
    WHERE user_id = ? AND created_at <= ? AND operation_kind IN (${WRITE_KINDS_SQL})
    ORDER BY created_at LIMIT ?)`).run(userId, edge, IDEMPOTENT_WRITE_PRUNE_ROWS);
}

// The sweep's beat (lib/server-lifecycle.ts): row-write keys over a day old,
// a slice at a time, never inside a write's transaction. Returns how many went.
export function pruneWriteKeys(now = Date.now(), slices = 20): number {
  const users = db.prepare('SELECT DISTINCT user_id FROM data_operation_ledger').pluck().all() as string[];
  const slice = db.prepare(`DELETE FROM data_operation_ledger WHERE id IN (SELECT id FROM data_operation_ledger
    WHERE user_id = ? AND created_at < ? AND operation_kind IN (${WRITE_KINDS_SQL}) LIMIT ?)`);
  let gone = 0;
  for (const userId of users) {
    for (let i = 0; i < slices; i++) {
      const n = slice.run(userId, cutoff(now), IDEMPOTENT_WRITE_PRUNE_ROWS).changes;
      gone += n;
      if (n < IDEMPOTENT_WRITE_PRUNE_ROWS) break;
    }
  }
  return gone;
}
