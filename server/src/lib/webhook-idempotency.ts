// A webhook delivery's Idempotency-Key (migration 049): a sender that retries
// after a timeout or a 5xx sends the same key with the same body, and the row
// is added once. A key is kept WEBHOOK_IDEMPOTENCY_MS for its webhook. The same
// key with another body is a new event, added like any other: a key only stops
// exact repeats, so someone holding the URL can't block a real event by
// sending junk under a key it will use, or learn which keys came in.
import { db } from './db';
import {
  WEBHOOK_IDEMPOTENCY_MS, WEBHOOK_IDEMPOTENCY_KEY_MAX, WEBHOOK_IDEMPOTENCY_PRUNE_ROWS,
  WEBHOOK_IDEMPOTENCY_PRUNE_SLICES,
} from './constants';

export const IDEMPOTENCY_HEADER = 'idempotency-key';

// Visible ASCII only: what senders put there (UUIDs, event ids), and nothing a
// log or a terminal could be tricked by.
const KEY_PATTERN = new RegExp(`^[\\x21-\\x7e]{1,${WEBHOOK_IDEMPOTENCY_KEY_MAX}}$`);

export function parseIdempotencyKey(raw: unknown): { key: string | null } | { error: string } {
  if (raw === undefined || raw === '') return { key: null };
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!KEY_PATTERN.test(key)) {
    return { error: `Idempotency-Key must be 1 to ${WEBHOOK_IDEMPOTENCY_KEY_MAX} visible ASCII characters.` };
  }
  return { key };
}

// SQLite's datetime('now') format, UTC.
const cutoff = () => new Date(Date.now() - WEBHOOK_IDEMPOTENCY_MS).toISOString().replace('T', ' ').slice(0, 19);

// Inside the delivery's transaction: a repeat of a delivery already added
// (this key with this body, within the day) adds nothing.
export function isRepeat(sourceId: string, userId: string, key: string, payloadSha: string): boolean {
  return !!db.prepare(`SELECT 1 FROM webhook_idempotency WHERE source_id = ? AND user_id = ? AND key = ?
    AND payload_sha256 = ? AND created_at >= ?`).get(sourceId, userId, key, payloadSha, cutoff());
}

// In the same transaction, once the row is in. A key seen with another body
// keeps its first one (it still stops that body's retries).
export function rememberKey(sourceId: string, userId: string, key: string, payloadSha: string): void {
  db.prepare(`INSERT INTO webhook_idempotency (source_id, user_id, key, payload_sha256) VALUES (?, ?, ?, ?)
    ON CONFLICT (source_id, key) DO UPDATE SET payload_sha256 = excluded.payload_sha256,
      created_at = excluded.created_at WHERE webhook_idempotency.created_at < ?`)
    .run(sourceId, userId, key, payloadSha, cutoff());
}

// Expired keys go in small slices, on the webhook sweep's beat (never inside a
// delivery's transaction): a busy webhook may hold many.
export function pruneWebhookKeys(): void {
  const slice = db.prepare(`DELETE FROM webhook_idempotency WHERE rowid IN (
    SELECT rowid FROM webhook_idempotency WHERE created_at < ? LIMIT ?)`);
  const before = cutoff();
  for (let i = 0; i < WEBHOOK_IDEMPOTENCY_PRUNE_SLICES; i++) {
    if (slice.run(before, WEBHOOK_IDEMPOTENCY_PRUNE_ROWS).changes < WEBHOOK_IDEMPOTENCY_PRUNE_ROWS) return;
  }
}
