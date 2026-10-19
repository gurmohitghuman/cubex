-- Setup versions (lib/setup-versions/, services/setup-version-*.ts): a named
-- copy of how a sheet's columns are set up, never their data. spec is every
-- listed column in order with its description, what fills it (an AI, HTTP API,
-- enrichment or waterfall column's newest run settings; a clean, formula or
-- lookup column's record) and its auto-run: lib/setup-versions/spec.ts. A
-- column rename rewrites the versions that name it, as it does every by-name
-- record. auto = 1: saved by a restore, of the setup it replaced. via and
-- token_name: who saved it (lib/actor.ts).
CREATE TABLE setup_versions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  auto INTEGER NOT NULL DEFAULT 0,
  spec TEXT NOT NULL,
  via TEXT NOT NULL DEFAULT 'app',
  token_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_setup_versions_sheet_name ON setup_versions(sheet_id, LOWER(name));
CREATE INDEX idx_setup_versions_user ON setup_versions(user_id);

-- A restored AI, HTTP API, enrichment or waterfall setup is a run record that
-- ran nothing (status completed, no rows, no results): a column's newest run
-- is its setup, so its reruns, auto-run, edit dialogs and details take it up.
-- Lists of what ran pass it by, and it has no usage record.
ALTER TABLE ai_runs ADD COLUMN setup_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE http_runs ADD COLUMN setup_only INTEGER NOT NULL DEFAULT 0;
