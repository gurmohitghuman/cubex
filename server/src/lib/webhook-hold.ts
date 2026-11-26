// Webhook deliveries that wait while their sheet is tested on a copy (services/sheet-test*.ts): kept whole in
// webhook_deliveries with status 'held' and no row yet (the prune leaves them), and added in arrival order once the
// test ends (services/sheet-test-webhooks.ts). While any wait, a new one waits behind them, so the order holds. A
// held delivery is an arrival: its key is remembered and the webhook's counters move, as when it adds a row.
import { v4 as uuidv4 } from 'uuid';
import { db } from './db';
import { WEBHOOK_HELD_MAX_BYTES, WEBHOOK_HELD_MAX_COUNT } from './constants';
import { sheetUnderTest } from './sheet-test-hold';
import { rememberKey } from './webhook-idempotency';

export const heldWaiting = (sheetId: string): boolean =>
  !!db.prepare("SELECT 1 FROM webhook_deliveries WHERE sheet_id = ? AND status = 'held' LIMIT 1").get(sheetId);

// Whether a delivery for this sheet waits now (call in the append transaction).
export const deliveryWaits = (sheetId: string): boolean => sheetUnderTest(sheetId) || heldWaiting(sheetId);

export type HoldOutcome = { held: true } | { full: string };

// Keeps one delivery (in the append transaction), or says the sheet keeps no more.
export function holdDelivery(
  source: { id: string; user_id: string; sheet_id: string }, rawPayloadText: string, payloadSha: string,
  payloadBytes: number, key: string | null,
): HoldOutcome {
  const kept = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(payload_bytes), 0) AS bytes FROM webhook_deliveries
    WHERE sheet_id = ? AND status = 'held'`).get(source.sheet_id) as { n: number; bytes: number };
  if (kept.n >= WEBHOOK_HELD_MAX_COUNT || kept.bytes + payloadBytes > WEBHOOK_HELD_MAX_BYTES) {
    return { full: 'This sheet is being tested and keeps no more deliveries until the test ends. Try again later.' };
  }
  db.prepare(`INSERT INTO webhook_deliveries (id, source_id, user_id, sheet_id, row_id, payload, payload_sha256,
      payload_bytes, status) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'held')`)
    .run(uuidv4(), source.id, source.user_id, source.sheet_id, rawPayloadText, payloadSha, payloadBytes);
  if (key) rememberKey(source.id, source.user_id, key, payloadSha);
  db.prepare(`UPDATE webhook_sources SET total_received = total_received + 1, last_received_at = datetime('now'),
      token_ciphertext = NULL, updated_at = datetime('now') WHERE id = ?`).run(source.id);
  return { held: true };
}
