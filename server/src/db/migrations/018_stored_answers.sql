-- Stored answers (services/answer-prune*.ts, answer-store-size.ts) and treg's
-- reachability for /api/health.

-- A row enriched again: once the run that answered it again has ended, the
-- raw part of the column's older answers at those rows is pruned (output and
-- _treg stay). answers_pruned = 0 is the durable record of a pass still to
-- do, so a restart finishes it; prune_cursor is the row_index it got to and
-- prune_generation the sheet's row_generation then (a sort moves results, and
-- the pass starts over).
ALTER TABLE http_runs ADD COLUMN answers_pruned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE http_runs ADD COLUMN prune_cursor INTEGER NOT NULL DEFAULT -1;
ALTER TABLE http_runs ADD COLUMN prune_generation INTEGER;
-- Plain HTTP runs keep no treg answers.
UPDATE http_runs SET answers_pruned = 1 WHERE json_type(config, '$.enrichment') IS NULL;
CREATE INDEX idx_http_runs_prune_due ON http_runs(status) WHERE answers_pruned = 0;

-- Settings' "Prune details older than 90 days": one job at a time, walking
-- the account's runs by rowid, then each run's results by row_index.
CREATE TABLE answer_prune_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  before TEXT NOT NULL,                  -- answers of runs that ended before this (datetime('now') form)
  run_cursor INTEGER NOT NULL DEFAULT 0, -- http_runs rowid of the run being pruned (or the last one done)
  row_cursor INTEGER NOT NULL DEFAULT -1,
  row_generation INTEGER,
  pruned INTEGER NOT NULL DEFAULT 0,     -- answers pruned so far
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_answer_prune_jobs_user ON answer_prune_jobs(user_id, created_at);

-- The stored answers' size, from the last background count.
CREATE TABLE answer_store_size (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  bytes INTEGER NOT NULL,
  answers INTEGER NOT NULL,
  counted_at TEXT NOT NULL
);

-- The outcome of Cubex's last call to treg ('ok' | 'unreachable') and since
-- when, written only when it changes.
ALTER TABLE settings ADD COLUMN treg_reach TEXT;
ALTER TABLE settings ADD COLUMN treg_reach_since TEXT;

-- A sheet's read sums each enrichment column's spend over all its runs (the
-- ⚡ header): from the index alone, never the runs' configs.
CREATE INDEX idx_http_runs_column_spend
  ON http_runs(sheet_id, master_column_name, user_id, spent_micro, processed_rows);

-- "+ Column" fills (answer-field-fill.ts) walk each run's results once, newest
-- run first, after linking the new column to the column's older runs in
-- batches: where the fill got to (a restart goes on from there).
ALTER TABLE enrichment_field_jobs ADD COLUMN stage TEXT NOT NULL DEFAULT 'link';
ALTER TABLE enrichment_field_jobs ADD COLUMN run_pos INTEGER NOT NULL DEFAULT 0;
ALTER TABLE enrichment_field_jobs ADD COLUMN row_cursor INTEGER NOT NULL DEFAULT -1;

-- Renaming or deleting a column rewrites every run that names it (master
-- column, configs). A column can hold tens of thousands of runs, so after the
-- switch transaction the rewrite goes on in pages, newest runs first, with the
-- sheet still busy (services/run-config-rewrite.ts); a restart finishes it.
CREATE TABLE run_config_rewrites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  old_name TEXT NOT NULL,
  new_name TEXT,                         -- NULL: the column was deleted
  before_rowid INTEGER NOT NULL,         -- the runs below this rowid are still to do
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_run_config_rewrites_sheet ON run_config_rewrites(sheet_id, id);
