-- Webhook deliveries a sender sends again (a retry after a timeout or a 5xx)
-- add their row once: a delivery may carry an Idempotency-Key header, kept here
-- for a day (lib/webhook-idempotency.ts). Kept apart from webhook_deliveries,
-- whose log is trimmed to its newest deliveries: a busy webhook would forget a
-- key within minutes. Expired keys are deleted in slices by the webhook sweep.
CREATE TABLE webhook_idempotency (
  source_id      TEXT NOT NULL REFERENCES webhook_sources(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key            TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source_id, key)
);
CREATE INDEX idx_webhook_idempotency_age ON webhook_idempotency(created_at);

-- A delivery added again from the log (services/webhook-replay.ts): the one it repeats.
ALTER TABLE webhook_deliveries ADD COLUMN replay_of TEXT;
