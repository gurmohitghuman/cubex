// Idempotency keys for row writes over /api/v1 and MCP (append_rows,
// update_cells and their REST routes), on the ledger run starts and
// transfer_rows use (data_operation_ledger, one key namespace per user). A row
// write's key replays its first answer for IDEMPOTENT_WRITE_TTL_MS (a day);
// after that the key is free again, for any kind of call. Every other kind's
// entry never expires here. The read and the write both run inside the
// caller's one immediate transaction (services/rows-write-keyed.ts), so two
// calls with one key, from two connections at once, write once: the second
// waits for the first's lock and then finds its entry.
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { db } from './db';
import { runInCheckpointedSlices } from './slices';
import {
  IDEMPOTENT_WRITE_KEYS_MAX, IDEMPOTENT_WRITE_PRUNE_APPENDS, IDEMPOTENT_WRITE_PRUNE_ROWS, IDEMPOTENT_WRITE_TTL_MS,
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

// A row write's entry under `key` over a day old, deleted: the key is free
// again. Every ledger reader calls this first (run starts in
// lib/run-idempotency.ts, transfer_rows in services/transfer-ledger.ts), so a
// run start or a transfer with that key goes ahead at once and records it,
// and its retry replays (left in place, the run's INSERT OR IGNORE would keep
// the old entry and the retry would start a second run).
export function forgetExpiredWriteKey(userId: string, key: string, now = Date.now()): void {
  db.prepare(`DELETE FROM data_operation_ledger WHERE user_id = ? AND idempotency_key = ?
    AND operation_kind IN (${WRITE_KINDS_SQL}) AND created_at < ?`).run(userId, key, cutoff(now));
}

export type LedgerRead<T> = { replay: T } | { conflict: true } | null;

// Inside the write's transaction: null (go ahead), the stored answer to
// replay, or a conflict (the key was used with other arguments, or by another
// kind of call). `sameCall` checks what the hash can't (a one-row update's
// optional sheet_id against the row's sheet). An expired row-write entry is
// deleted first, so the key can be stored again in the same transaction.
export function readWriteLedger<T>(
  userId: string, key: string, hash: string, sameCall?: (stored: T) => boolean, now = Date.now(),
): LedgerRead<T> {
  forgetExpiredWriteKey(userId, key, now);
  const row = db.prepare(`SELECT request_hash, result_json FROM data_operation_ledger
    WHERE user_id = ? AND idempotency_key = ?`).get(userId, key) as
    { request_hash: string; result_json: string } | undefined;
  if (!row) return null;
  if (row.request_hash !== hash) return { conflict: true };
  const stored = JSON.parse(row.result_json) as T;
  return sameCall && !sameCall(stored) ? { conflict: true } : { replay: stored };
}

// In the same transaction, after the rows were written. A user past
// IDEMPOTENT_WRITE_KEYS_MAX row-write keys loses its oldest: the edge is the
// newest KEYS_MAX-th row-write key (run and transfer keys don't count, and keep
// their own rule), and only keys older than its second go, so the newest
// KEYS_MAX always stay (a few more when several share that second).
export function writeWriteLedger(userId: string, key: string, kind: WriteKind, hash: string, stored: unknown): void {
  db.prepare(`INSERT INTO data_operation_ledger
      (id, user_id, idempotency_key, operation_kind, request_hash, result_json)
    VALUES (?, ?, ?, ?, ?, ?)`).run(uuidv4(), userId, key, kind, hash, JSON.stringify(stored));
  const edge = db.prepare(`SELECT created_at FROM data_operation_ledger
    WHERE user_id = ? AND operation_kind IN (${WRITE_KINDS_SQL})
    ORDER BY created_at DESC LIMIT 1 OFFSET ?`).pluck().get(userId, IDEMPOTENT_WRITE_KEYS_MAX - 1) as
    string | undefined;
  if (edge === undefined) return;
  db.prepare(`DELETE FROM data_operation_ledger WHERE id IN (SELECT id FROM data_operation_ledger
    WHERE user_id = ? AND created_at < ? AND operation_kind IN (${WRITE_KINDS_SQL})
    ORDER BY created_at LIMIT ?)`).run(userId, edge, IDEMPOTENT_WRITE_PRUNE_ROWS);
}

// The sweep's beat (lib/server-lifecycle.ts): row-write keys over a day old,
// never inside a write's transaction. A slice at a time, a kind at a time
// (appends' answers are the big ones, so their slices are smaller), yielding
// to requests and with a PASSIVE checkpoint after each slice, as the trash
// purge does (lib/slices.ts): secure_delete zeroes every page a slice frees.
// One sweep at a time. Resolves to how many went.
let sweeping = false;
export async function pruneWriteKeys(now = Date.now()): Promise<number> {
  if (sweeping) return 0;
  sweeping = true;
  try {
    const before = cutoff(now);
    const users = db.prepare(`SELECT DISTINCT user_id FROM data_operation_ledger
      WHERE created_at < ? AND operation_kind IN (${WRITE_KINDS_SQL})`).pluck().all(before) as string[];
    const slice = db.prepare(`DELETE FROM data_operation_ledger WHERE id IN (SELECT id FROM data_operation_ledger
      WHERE user_id = ? AND created_at < ? AND operation_kind = ? LIMIT ?)`);
    let gone = 0;
    for (const userId of users) {
      for (const kind of WRITE_KINDS) {
        const size = kind === 'rows_append' ? IDEMPOTENT_WRITE_PRUNE_APPENDS : IDEMPOTENT_WRITE_PRUNE_ROWS;
        await runInCheckpointedSlices(() => {
          const n = slice.run(userId, before, kind, size).changes;
          gone += n;
          return n > 0;
        });
      }
    }
    return gone;
  } finally {
    sweeping = false;
  }
}
