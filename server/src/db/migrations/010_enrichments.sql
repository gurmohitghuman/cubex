-- Enrichments powered by treg.to: Clay-style lookups (work emails, phones,
-- person and company data, lists) run per row with the user's own treg key
-- (docs/enrichments.md). An enrichment is an http_runs row whose config carries
-- an `enrichment` block, so runs, results, placeholders and SSE are shared with
-- HTTP API columns; the tables below hold what HTTP columns never needed.

-- The user's treg key, AES-256-GCM like the OpenRouter key (lib/crypto.ts), and
-- one daily limit for everything enrichments spend, in micro-USD per UTC day.
-- On by default ($10); NULL turns it off.
ALTER TABLE settings ADD COLUMN treg_token_encrypted TEXT;
ALTER TABLE settings ADD COLUMN enrich_daily_limit_micro INTEGER DEFAULT 10000000;

-- A list enrichment adds each result as a row in another sheet. Sort, CSV
-- replace and bulk delete on that sheet treat the run as active.
ALTER TABLE http_runs ADD COLUMN dest_sheet_id TEXT REFERENCES sheets(id) ON DELETE SET NULL;
CREATE INDEX idx_http_runs_dest_sheet ON http_runs(dest_sheet_id) WHERE dest_sheet_id IS NOT NULL;

-- What a row's calls cost, for status polls (one index-only scan, as 008 does
-- for AI). Totals and caps read the ledger below: result rows vanish on row
-- delete, CSV replace and sort cleanup.
ALTER TABLE http_results ADD COLUMN cost_usd REAL;
CREATE INDEX idx_http_results_run_outcome ON http_results(run_id, status, cost_usd);
DROP INDEX idx_http_results_run_status;

-- Every treg call, written as soon as its response headers arrive and before
-- the row's result, so paused, cancelled and failed rows still count. Keyed by
-- the stable rows.id (sort remaps only ai_results/http_results). sheet_id and
-- run_id are plain ids, not foreign keys: spend history outlives its sheet,
-- and nulling a million ledger rows inside a sheet delete would hold the
-- write lock past busy_timeout.
CREATE TABLE enrichment_calls (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sheet_id TEXT,
  run_id TEXT,
  row_id TEXT,
  status_column TEXT,
  tool_id TEXT NOT NULL,
  attempt TEXT NOT NULL,                    -- t1 single tool, g1 guess check, f1/v1/f2/v2 email loop
  idempotency_key TEXT,                     -- what boot recovery re-sends for an unconfirmed call
  call_id TEXT,                             -- X-Treg-Call-Id
  cost_micro INTEGER,                       -- X-Treg-Cost-Micro; NULL = unmetered (own key, free route)
  original_cost_micro INTEGER,              -- what an idempotent replay originally cost
  http_status INTEGER,
  treg_error TEXT,                          -- treg's own refusal code (X-Treg-Error)
  served_by TEXT,
  served_via TEXT,                          -- overflow:<aggregator> when treg's own account was out
  tier TEXT,                                -- tool | credential | anonymous | platform
  cache_hit INTEGER NOT NULL DEFAULT 0,
  replay INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_enrichment_calls_user_time ON enrichment_calls(user_id, created_at);
CREATE INDEX idx_enrichment_calls_sheet_col_time ON enrichment_calls(sheet_id, status_column, created_at);
CREATE INDEX idx_enrichment_calls_run_row ON enrichment_calls(run_id, row_id);

-- Today's spend, updated in the same transaction as each ledger insert, so the
-- daily limit is one row read instead of a SUM over millions of calls.
CREATE TABLE enrich_daily_spend (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,                        -- UTC date, YYYY-MM-DD
  spent_micro INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- Auto-run for enrichment and HTTP API columns: fills any row that has its
-- inputs and hasn't been run yet, whether it's new (above the watermark) or its
-- inputs just got filled (autorun_pending, fed inside each write transaction).
CREATE TABLE autorun_columns (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  status_column TEXT NOT NULL,
  kind TEXT NOT NULL,                       -- 'enrichment' | 'http', checked in code so a new kind needs no rebuild
  enabled INTEGER NOT NULL DEFAULT 1,
  input_columns TEXT NOT NULL DEFAULT '[]', -- JSON column names the config reads
  where_json TEXT,                          -- JSON row conditions ("Only run if")
  daily_cap_micro INTEGER,                  -- enrichment columns
  daily_row_cap INTEGER,                    -- HTTP columns (they cost nothing at treg but can have side effects)
  watermark_row_index INTEGER NOT NULL DEFAULT -1,
  rescan INTEGER NOT NULL DEFAULT 0,
  row_generation_seen INTEGER NOT NULL DEFAULT 0,
  data_version_seen INTEGER NOT NULL DEFAULT 0,
  paused_reason TEXT,                       -- why it is stopped; 'user' = paused on purpose
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(sheet_id, status_column)
);
CREATE INDEX idx_autorun_columns_user ON autorun_columns(user_id);

CREATE TABLE autorun_pending (
  autorun_id TEXT NOT NULL REFERENCES autorun_columns(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  row_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (autorun_id, row_id)
);

-- "Add as column" from saved answers: a sliced fill (no treg calls) that boot
-- finishes if the server stops partway, like column_purges.
CREATE TABLE enrichment_field_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  status_column TEXT NOT NULL,
  column_name TEXT NOT NULL,
  json_path TEXT NOT NULL,
  cursor_rowid INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_enrichment_field_jobs_running ON enrichment_field_jobs(status) WHERE status = 'running';
CREATE INDEX idx_enrichment_field_jobs_sheet ON enrichment_field_jobs(sheet_id);

-- List results waiting to become rows in another sheet. Workers can't append
-- (the sheet-busy lock lives in the API process), so the run journals each
-- source row's items and the API process drains them, one transaction each.
CREATE TABLE enrichment_list_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES http_runs(id) ON DELETE CASCADE,
  source_sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  source_row_id TEXT NOT NULL,
  dest_sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  items_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_enrichment_list_items_pending ON enrichment_list_items(status, created_at) WHERE status = 'pending';
CREATE INDEX idx_enrichment_list_items_run ON enrichment_list_items(run_id);
CREATE INDEX idx_enrichment_list_items_source ON enrichment_list_items(source_sheet_id);
CREATE INDEX idx_enrichment_list_items_dest ON enrichment_list_items(dest_sheet_id);

-- Which rows a list enrichment added, so a rerun of a source row replaces its
-- earlier items and "skip items already added" is an index lookup, not a scan.
CREATE TABLE enrichment_list_rows (
  dest_row_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dest_sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  source_sheet_id TEXT,                     -- plain id: the source sheet can go while these rows stay
  source_row_id TEXT NOT NULL,
  status_column TEXT NOT NULL,
  run_id TEXT,
  dedupe_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_enrichment_list_rows_source ON enrichment_list_rows(source_sheet_id, status_column, source_row_id);
-- Serves both the sheet-delete cascade (prefix) and the dedupe lookup.
CREATE INDEX idx_enrichment_list_rows_dest ON enrichment_list_rows(dest_sheet_id, dedupe_key);
