-- A saved setup called on items without a sheet (services/setup-call.ts): the items become the rows of a hidden
-- working table, and the setup runs there as on any sheet (setup_runs, its step runs, their webhooks). hidden: the
-- app, /api/v1 and MCP never list or count the table; it is deleted SETUP_CALL_KEEP_HOURS after its call finishes.
-- setup_calls.id is the setup run's id, so polling and the run-finished webhook name the same id.
ALTER TABLE tables ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_tables_hidden ON tables(created_at) WHERE hidden = 1;

CREATE TABLE setup_calls (
  id TEXT PRIMARY KEY REFERENCES setup_runs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  items INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_setup_calls_table ON setup_calls(table_id);
