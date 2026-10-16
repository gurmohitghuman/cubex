-- Using a setup on a sheet (services/setup-runner.ts): its steps fitted to the
-- sheet (plan: the remapped spec and when each step starts), started a layer
-- at a time, each layer once every run of the one before has finished, since
-- a step reads the columns earlier steps fill (AI columns have no auto-run to
-- follow them). steps: per step its state and the run (or clean/formula
-- record) it started, so a restart picks the chain up where it was: the
-- runner's sweep reads this table, never memory. A step marked 'starting'
-- when the server stopped is matched to the run its start made, if any.
CREATE TABLE setup_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  setup_id TEXT REFERENCES setups(id) ON DELETE SET NULL,
  setup_name TEXT NOT NULL,
  plan TEXT NOT NULL,                       -- JSON: { spec, layers }
  steps TEXT NOT NULL,                      -- JSON: [{ state, runId, recordId, error }]
  target_row_ids TEXT,                      -- JSON stable row ids (a test on the first rows); NULL = every row
  allow_secrets INTEGER NOT NULL DEFAULT 1, -- the caller could use saved keys (a token without 'secrets' can't)
  auto_run INTEGER NOT NULL DEFAULT 1,      -- turn the setup's auto-runs on once it's done (not for a test)
  layer INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'paused', 'done', 'failed', 'cancelled')),
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_setup_runs_live ON setup_runs(status) WHERE status IN ('running', 'paused');
CREATE INDEX idx_setup_runs_sheet ON setup_runs(sheet_id, created_at);
