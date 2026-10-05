import { v4 as uuidv4 } from 'uuid';
import { db } from './db';
import { appendColumnsToOrder, getSheetColumns } from './sql-helpers';
import { findColumnNameCollision } from './column-names';
import { generateWebhookToken, revealWebhookSecret, sha256Hex } from './webhook-token';

// Shared logic for the authenticated webhook-management routes (mounted under
// /api/sheets/:id). Keeps the route files thin. Every function here is called
// from a handler that already verified the user owns the sheet.

// The URL senders POST to. With PUBLIC_URL set (e.g. https://cubex.example.com)
// it's absolute — use that when webhooks arrive at a different address than the
// one you browse on (a tunnel, a public domain in front of a LAN install).
// Otherwise it's a path, and the browser resolves it against the address the
// user is actually on (WebhookEndpoint.tsx).
export function webhookUrlForSecret(secret: string): string {
  const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  return `${base}/api/webhooks/${secret}`;
}

export interface WebhookSourceFull {
  id: string;
  user_id: string;
  sheet_id: string;
  token_ciphertext: string | null;
  enabled: number;
  name: string;
  raw_column_name: string;
  store_raw_mode: string;
  total_received: number;
  last_received_at: string | null;
  last_error_at: string | null;
  last_error_message: string | null;
  created_at: string;
  rotated_at: string | null;
}

export function getSourceForSheet(sheetId: string, userId: string): WebhookSourceFull | null {
  return (db.prepare(
    `SELECT * FROM webhook_sources WHERE sheet_id = ? AND user_id = ?`,
  ).get(sheetId, userId) as WebhookSourceFull | undefined) ?? null;
}

// The client-safe view of a source. The full URL is ONLY included while the
// reveal window is open, which is EXACTLY "we still hold the transient
// ciphertext" — the append txn nulls token_ciphertext on the first delivery, so
// `token_ciphertext != null` is the single source of truth for revealability.
// (We deliberately do NOT gate on total_received, so rotate can keep the
// historical delivery count cumulative while re-opening the reveal window.)
// Never returns the token_hash or the ciphertext.
export function serializeSource(src: WebhookSourceFull): Record<string, unknown> {
  const revealable = !!src.token_ciphertext;
  const secret = revealable ? revealWebhookSecret(src.token_ciphertext) : null;
  return {
    id: src.id,
    sheetId: src.sheet_id,
    name: src.name,
    enabled: src.enabled === 1,
    rawColumnName: src.raw_column_name,
    storeRawMode: src.store_raw_mode,
    totalReceived: src.total_received,
    lastReceivedAt: src.last_received_at,
    lastErrorAt: src.last_error_at,
    lastErrorMessage: src.last_error_message,
    createdAt: src.created_at,
    rotatedAt: src.rotated_at,
    // Reveal window: full URL until first delivery, then masked.
    masked: !revealable,
    url: secret ? webhookUrlForSecret(secret) : null,
  };
}

export interface WebhookMappingView {
  id: string;
  jsonPath: string;
  columnName: string;
  valueMode: string;
  createdAt: string;
}

export function listMappings(sourceId: string): WebhookMappingView[] {
  const rows = db.prepare(
    `SELECT id, json_path, column_name, value_mode, created_at
       FROM webhook_mappings WHERE source_id = ? ORDER BY created_at ASC`,
  ).all(sourceId) as Array<{
    id: string; json_path: string; column_name: string; value_mode: string; created_at: string;
  }>;
  return rows.map(r => ({
    id: r.id, jsonPath: r.json_path, columnName: r.column_name,
    valueMode: r.value_mode, createdAt: r.created_at,
  }));
}

// Create a webhook source for a sheet + its visible read-only marker column.
// Picks a non-colliding raw-column name, appends it to column_order, and inserts
// the source row. Runs in ONE transaction. Returns the created source + secret.
export function createSourceWithColumn(
  sheetId: string,
  userId: string,
  desiredName: string,
): { source: WebhookSourceFull; secret: string } {
  const tok = generateWebhookToken();
  const rawColumnName = pickRawColumnName(sheetId, userId);
  const id = uuidv4();

  db.transaction(() => {
    // Listing the marker column is what creates it (lib/sheet-columns.ts). No
    // row is touched, so this costs the same on a million-row sheet as on an
    // empty one, and a new webhook sheet stays empty: the first event is row 0.
    appendColumnsToOrder(sheetId, userId, [rawColumnName]);

    db.prepare(
      `INSERT INTO webhook_sources
         (id, user_id, sheet_id, token_hash, token_ciphertext, name, raw_column_name)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, userId, sheetId, tok.tokenHash, tok.tokenCiphertext, desiredName, rawColumnName);
  })();

  const source = db.prepare('SELECT * FROM webhook_sources WHERE id = ?').get(id) as WebhookSourceFull;
  return { source, secret: tok.secret };
}

// Rotate the secret: new token + hash + a FRESH transient ciphertext (which
// re-opens the reveal window — revealability keys on token_ciphertext != null),
// stamp rotated_at. The old URL stops working immediately (its hash is gone).
// total_received is KEPT cumulative so the status line's historical count
// survives a rotate; clearing last_error too since it referred to the now-dead
// URL. The rate-limit bucket is keyed on source.id, NOT the token, so it
// deliberately persists across rotation (rotate can't reset the throttle).
// Returns the new secret for display.
export function rotateSource(src: WebhookSourceFull): string {
  const tok = generateWebhookToken();
  db.prepare(
    `UPDATE webhook_sources
        SET token_hash = ?, token_ciphertext = ?, rotated_at = datetime('now'),
            last_error_at = NULL, last_error_message = NULL,
            updated_at = datetime('now')
      WHERE id = ?`,
  ).run(tok.tokenHash, tok.tokenCiphertext, src.id);
  return tok.secret;
}

// Pick a marker-column name that doesn't collide with an existing column on ANY
// axis (exact/case/normalized-/token). With relaxed names, "Webhook" could now
// collide with an existing "# Webhook" (both → /webhook), so check the /token too.
// "Webhook", then "Webhook 2", "Webhook 3", ...
function pickRawColumnName(sheetId: string, userId: string): string {
  const existing = getSheetColumns(sheetId, userId);
  if (!findColumnNameCollision('Webhook', existing)) return 'Webhook';
  for (let n = 2; n < 1000; n++) {
    const candidate = `Webhook ${n}`;
    if (!findColumnNameCollision(candidate, existing)) return candidate;
  }
  return `Webhook ${uuidv4().slice(0, 8)}`;
}

export { sha256Hex };
