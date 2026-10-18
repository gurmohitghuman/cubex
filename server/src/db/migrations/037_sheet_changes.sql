-- A sheet's change log (services/sheet-history.ts): its setup changes (columns
-- added, renamed and deleted, runs started and stopped, auto-run, "Only run
-- if" rules and defaults, clean, formula and lookup columns, views, its
-- webhook) and the big changes to its rows (deleted, restored, imported,
-- sorted, duplicates removed): when, and through what: the app, an access
-- token by name (over the API or MCP) or Cubex itself. Kept CHANGE_LOG_DAYS
-- (90), pruned in slices; it goes with its sheet.
CREATE TABLE sheet_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  via TEXT NOT NULL CHECK (via IN ('app', 'api', 'mcp', 'cubex')),
  token_name TEXT,
  action TEXT NOT NULL,                     -- e.g. column_added, run_started, rows_deleted
  column_name TEXT,                         -- the column it was about, if one
  summary TEXT NOT NULL,                    -- one line in plain words
  detail TEXT                               -- JSON, small: what changed
);
CREATE INDEX idx_sheet_changes_sheet ON sheet_changes(sheet_id, id);
CREATE INDEX idx_sheet_changes_at ON sheet_changes(at);
