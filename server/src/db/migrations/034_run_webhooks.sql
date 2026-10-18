-- "Run finished" webhooks (services/run-hooks-*.ts, docs/run-webhooks.md): when
-- an AI, HTTP, enrichment or setup run reaches a final status, Cubex POSTs a
-- signed notice to the account's webhook URLs. Delivery isn't guaranteed (the
-- receiver can be down); polling a run stays the source of truth.

-- A URL to notify. The signing secret is shown once and kept encrypted
-- (lib/crypto.ts). every_run = 0: only runs started with this webhook_id.
CREATE TABLE run_webhooks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret_encrypted TEXT NOT NULL,
  every_run INTEGER NOT NULL DEFAULT 1 CHECK (every_run IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, url)
);

-- The webhook a run was started with (REST/MCP webhook_id). No foreign key: a
-- deleted webhook just isn't notified.
ALTER TABLE ai_runs ADD COLUMN webhook_id TEXT;
ALTER TABLE http_runs ADD COLUMN webhook_id TEXT;
ALTER TABLE setup_runs ADD COLUMN webhook_id TEXT;

-- Runs that just finished, waiting to be turned into deliveries by the API
-- process (services/run-hooks-dispatch.ts). Written by the triggers below in the
-- same transaction as the status change, on every connection (the run workers'
-- included), so a finish can't be missed or written twice. named_only: queued
-- for the run's own webhook only (attached after the run had finished,
-- services/run-hooks-attach.ts).
CREATE TABLE run_webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ai', 'http', 'enrichment', 'setup')),
  sheet_id TEXT NOT NULL,
  status TEXT NOT NULL,
  webhook_id TEXT,
  named_only INTEGER NOT NULL DEFAULT 0,
  finished_at TEXT NOT NULL
);

-- One POST to one webhook, with its tries; the last RUN_HOOK_LOG_KEEP finished
-- ones per webhook are kept as its delivery log. body is the exact JSON sent
-- (and signed), so every try sends the same bytes.
CREATE TABLE run_webhook_deliveries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  webhook_id TEXT NOT NULL REFERENCES run_webhooks(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  run_id TEXT,
  kind TEXT,
  run_status TEXT,
  body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'delivered', 'failed')),
  tries INTEGER NOT NULL DEFAULT 0,
  next_try_at INTEGER NOT NULL,             -- ms since the epoch
  response_code INTEGER,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT
);
CREATE INDEX idx_run_webhook_deliveries_due ON run_webhook_deliveries(next_try_at) WHERE state = 'pending';
CREATE INDEX idx_run_webhook_deliveries_log ON run_webhook_deliveries(webhook_id, created_at);

-- A run reaching completed / failed / cancelled (a setup's 'done' is reported
-- as completed) queues a notice, only when the run names a webhook or the
-- account has one for every run. Built-in SQL only (trusted_schema=OFF).
-- json_valid first: a run whose config isn't JSON must still be able to fail.
CREATE TRIGGER run_webhook_ai_finished AFTER UPDATE OF status ON ai_runs
WHEN NEW.status IN ('completed', 'failed', 'cancelled')
  AND OLD.status NOT IN ('completed', 'failed', 'cancelled')
  AND (NEW.webhook_id IS NOT NULL
    OR EXISTS (SELECT 1 FROM run_webhooks w WHERE w.user_id = NEW.user_id AND w.every_run = 1))
BEGIN
  INSERT INTO run_webhook_events (user_id, run_id, kind, sheet_id, status, webhook_id, finished_at)
  VALUES (NEW.user_id, NEW.id, 'ai', NEW.sheet_id, NEW.status, NEW.webhook_id,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER run_webhook_http_finished AFTER UPDATE OF status ON http_runs
WHEN NEW.status IN ('completed', 'failed', 'cancelled')
  AND OLD.status NOT IN ('completed', 'failed', 'cancelled')
  AND (NEW.webhook_id IS NOT NULL
    OR EXISTS (SELECT 1 FROM run_webhooks w WHERE w.user_id = NEW.user_id AND w.every_run = 1))
BEGIN
  INSERT INTO run_webhook_events (user_id, run_id, kind, sheet_id, status, webhook_id, finished_at)
  VALUES (NEW.user_id, NEW.id,
    CASE WHEN NEW.config IS NULL OR NOT json_valid(NEW.config) THEN 'http'
      WHEN json_type(NEW.config, '$.enrichment') = 'object' THEN 'enrichment' ELSE 'http' END,
    NEW.sheet_id, NEW.status, NEW.webhook_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER run_webhook_setup_finished AFTER UPDATE OF status ON setup_runs
WHEN NEW.status IN ('done', 'failed', 'cancelled')
  AND OLD.status NOT IN ('done', 'failed', 'cancelled')
  AND (NEW.webhook_id IS NOT NULL
    OR EXISTS (SELECT 1 FROM run_webhooks w WHERE w.user_id = NEW.user_id AND w.every_run = 1))
BEGIN
  INSERT INTO run_webhook_events (user_id, run_id, kind, sheet_id, status, webhook_id, finished_at)
  VALUES (NEW.user_id, NEW.id, 'setup', NEW.sheet_id,
    CASE NEW.status WHEN 'done' THEN 'completed' ELSE NEW.status END, NEW.webhook_id,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
