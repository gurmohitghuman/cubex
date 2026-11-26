-- One enrichment tool called on items without a sheet (services/enrich-call.ts): the items become the rows of a
-- hidden working table (tables.hidden, migration 067) and the tool runs there as an ordinary enrichment run, whose
-- status and per-row results (get_run_status, get_run_results) answer for the call. enrichment_item_calls.id is
-- that run's id; the working table is deleted SETUP_CALL_KEEP_HOURS after the run finishes, as a setup call's is.
CREATE TABLE enrichment_item_calls (
  id TEXT PRIMARY KEY REFERENCES http_runs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  items INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_enrichment_item_calls_table ON enrichment_item_calls(table_id);
