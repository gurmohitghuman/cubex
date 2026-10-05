-- Cubex schema. Every later change ships as a NEW numbered migration
-- (002_..., 003_...); never edit this file once a release has shipped it.
--
-- Storage is row-oriented: each spreadsheet row is one `rows` record with all
-- of its cells in `rows.data` as a JSON object ({"Column name": "value"}).
-- Every table carries user_id; Cubex is single-user, but every query still
-- scopes by it.

-- ---- Account ------------------------------------------------------------

-- At most one row: whoever opens a fresh install first sets the password.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,              -- argon2id
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  session_epoch INTEGER NOT NULL DEFAULT 0  -- bumped on logout / password change; revokes older sessions
);

CREATE TABLE settings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  openrouter_api_key_encrypted TEXT,        -- AES-256-GCM (lib/crypto.ts)
  default_ai_model TEXT                     -- account default; there is no built-in default model
);
CREATE INDEX idx_settings_user ON settings(user_id);

-- Named secrets for HTTP enrichment templates.
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_type TEXT NOT NULL CHECK (key_type IN ('bearer', 'api_key', 'custom')),
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  key_value_encrypted TEXT NOT NULL,        -- AES-256-GCM (lib/crypto.ts)
  UNIQUE(user_id, name)
);
CREATE INDEX idx_api_keys_user ON api_keys(user_id);

-- Personal access tokens for /api/v1 and /mcp. Only the sha256 is stored.
CREATE TABLE access_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  scopes TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE UNIQUE INDEX idx_access_tokens_user_name_ci
  ON access_tokens(user_id, LOWER(name)) WHERE revoked_at IS NULL;
CREATE INDEX idx_access_tokens_user ON access_tokens(user_id);

-- ---- Tables, sheets, rows ------------------------------------------------

CREATE TABLE tables (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_tables_user ON tables(user_id);
CREATE UNIQUE INDEX idx_tables_user_name ON tables(user_id, name);

CREATE TABLE sheets (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,      -- tab order
  column_order TEXT,                        -- JSON string array: THE column position store
  sort_state TEXT,                          -- JSON {column, direction}
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  default_ai_model TEXT,
  empty_filter TEXT,
  row_generation INTEGER NOT NULL DEFAULT 0, -- bumped when row_index meanings change (sort, CSV replace)
  default_ai_concurrency INTEGER,
  data_version INTEGER NOT NULL DEFAULT 0,   -- bumped on every data change; the live-update poll signal
  column_filters TEXT
);
CREATE INDEX idx_sheets_table ON sheets(table_id);
CREATE INDEX idx_sheets_user ON sheets(user_id);
CREATE UNIQUE INDEX idx_sheets_table_name_ci ON sheets(table_id, LOWER(name));

CREATE TABLE rows (
  id TEXT PRIMARY KEY,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',          -- JSON object: { "columnName": "value", ... }
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(sheet_id, row_index)
);
CREATE INDEX idx_rows_sheet ON rows(sheet_id);
CREATE INDEX idx_rows_user ON rows(user_id);

-- ---- AI columns ----------------------------------------------------------

CREATE TABLE ai_runs (
  id TEXT PRIMARY KEY,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  column_name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  system_prompt TEXT,
  model TEXT,
  temperature REAL,
  max_chars INTEGER,
  concurrency INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','paused','completed','failed','cancelled')),
  total_rows INTEGER NOT NULL DEFAULT 0,
  processed_rows INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  use_openrouter_web_search INTEGER NOT NULL DEFAULT 0,
  use_web_fetch INTEGER NOT NULL DEFAULT 0,
  worker_generation INTEGER NOT NULL DEFAULT 0,
  target_rows TEXT,                         -- JSON row_index list for reruns; NULL = whole sheet
  error_message TEXT,
  output_columns TEXT,                      -- JSON [{columnName,type,description}]; NULL = single column
  status_column TEXT
);
CREATE INDEX idx_ai_runs_user ON ai_runs(user_id);
CREATE INDEX idx_ai_runs_sheet ON ai_runs(sheet_id);

CREATE TABLE ai_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ai_runs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL,
  input_values TEXT,                        -- JSON
  output_value TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed','accepted','rejected')),
  error_message TEXT,
  scraped_data TEXT,                        -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  prompt_tokens INTEGER,
  completion_tokens INTEGER
);
CREATE INDEX idx_ai_results_run ON ai_results(run_id);
CREATE INDEX idx_ai_results_user ON ai_results(user_id);

-- The AI column modal's saved state (prompt + paid-for preview) per sheet.
CREATE TABLE ai_column_drafts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  config_json TEXT NOT NULL,                -- DraftConfig (lib/ai-drafts.ts)
  config_hash TEXT NOT NULL,                -- sha256 over the reuse-relevant config fields
  row_generation INTEGER,                   -- sheets.row_generation when the preview ran
  run_target_rows INTEGER,                  -- "Run All Rows" count from the preview (cost-estimate restore)
  preview_results_json TEXT,                -- NULL until a preview COMPLETES (all-or-nothing)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_ai_column_drafts_user_sheet ON ai_column_drafts(user_id, sheet_id);
CREATE INDEX idx_ai_column_drafts_sheet ON ai_column_drafts(sheet_id);

-- ---- HTTP enrichment -----------------------------------------------------

CREATE TABLE http_runs (
  id TEXT PRIMARY KEY,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  config TEXT,                              -- JSON
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','paused','completed','failed','cancelled')),
  total_rows INTEGER NOT NULL DEFAULT 0,
  processed_rows INTEGER NOT NULL DEFAULT 0,
  master_column_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  worker_generation INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  target_rows TEXT,
  allow_secrets INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_http_runs_user ON http_runs(user_id);
CREATE INDEX idx_http_runs_sheet ON http_runs(sheet_id);

CREATE TABLE http_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES http_runs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL,
  request_config TEXT,                      -- JSON
  response_data TEXT,                       -- JSON
  extracted_fields TEXT,                    -- JSON
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_http_results_run ON http_results(run_id);
CREATE INDEX idx_http_results_user ON http_results(user_id);
CREATE UNIQUE INDEX idx_http_results_run_row ON http_results(run_id, row_index);

CREATE TABLE http_column_associations (
  id TEXT PRIMARY KEY,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  master_column_name TEXT,
  extracted_column_name TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_http_assoc_sheet ON http_column_associations(sheet_id);
CREATE INDEX idx_http_assoc_user ON http_column_associations(user_id);

CREATE TABLE http_api_templates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  config TEXT,                              -- JSON
  tags TEXT,                                -- JSON array
  is_draft INTEGER NOT NULL DEFAULT 0,
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_http_templates_user ON http_api_templates(user_id);
CREATE UNIQUE INDEX idx_http_templates_user_name ON http_api_templates(user_id, name);

-- ---- Incoming webhooks (docs/webhooks.md) --------------------------------

CREATE TABLE webhook_sources (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  sheet_id         TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  token_hash       TEXT NOT NULL UNIQUE,        -- sha256(secret) hex; primary lookup key
  -- Transient encrypted copy of the raw secret, AES-256-GCM. Lets the drawer
  -- re-reveal the full URL UNTIL the first delivery, then SET NULL on first
  -- delivery -> hash-only, genuinely unrecoverable.
  token_ciphertext TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  name             TEXT NOT NULL DEFAULT 'Webhook',
  raw_column_name  TEXT NOT NULL,               -- the visible system "Webhook" column
  store_raw_mode   TEXT NOT NULL DEFAULT 'marker', -- 'marker' | 'none'
  total_received   INTEGER NOT NULL DEFAULT 0,
  last_received_at TEXT,
  last_error_at    TEXT,
  last_error_message TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  rotated_at       TEXT,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_webhook_sources_sheet ON webhook_sources(sheet_id);
CREATE INDEX idx_webhook_sources_user ON webhook_sources(user_id);
CREATE UNIQUE INDEX idx_webhook_sources_one_per_sheet ON webhook_sources(sheet_id);

CREATE TABLE webhook_mappings (
  id           TEXT PRIMARY KEY,
  source_id    TEXT NOT NULL REFERENCES webhook_sources(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  json_path    TEXT NOT NULL,                   -- jsonpath-plus dialect, e.g. $.data.email
  column_name  TEXT NOT NULL,
  value_mode   TEXT NOT NULL DEFAULT 'scalar',  -- 'scalar' | 'json'
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_webhook_mappings_col ON webhook_mappings(source_id, lower(column_name));

CREATE TABLE webhook_deliveries (
  id               TEXT PRIMARY KEY,
  source_id        TEXT NOT NULL REFERENCES webhook_sources(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sheet_id         TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  row_id           TEXT REFERENCES rows(id) ON DELETE SET NULL,  -- the appended row
  payload          TEXT NOT NULL,               -- raw JSON text, capped (512 KB)
  payload_sha256   TEXT NOT NULL,
  payload_bytes    INTEGER NOT NULL,
  status           TEXT NOT NULL,               -- 'stored' | 'partial' | 'error'
  error_message    TEXT,
  received_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_webhook_deliveries_source ON webhook_deliveries(source_id, received_at DESC);
CREATE INDEX idx_webhook_deliveries_row ON webhook_deliveries(row_id);

-- ---- Idempotency (MCP / API run starts and row transfers) ---------------

CREATE TABLE data_operation_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, idempotency_key)
);
CREATE INDEX idx_data_operation_ledger_created ON data_operation_ledger(user_id, created_at);
