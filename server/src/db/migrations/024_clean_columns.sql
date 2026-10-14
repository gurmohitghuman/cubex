-- Clean data columns (services/clean-column.ts): a column filled for free from
-- another column of the sheet by a pure cleaner (lib/clean/), with no request
-- and no model call. Kept by column name, as auto-run keeps its columns: a
-- rename or delete updates it (lib/clean-columns.ts). The fill runs in slices
-- with the sheet busy and keeps its place in fill_cursor (rows up to that
-- rowid are done), so a restart finishes it (services/clean-fill.ts). Auto-run
-- on a clean column is an autorun_columns entry of kind 'clean'
-- (services/clean-follow.ts).
CREATE TABLE clean_columns (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  column_name TEXT NOT NULL,
  source_column TEXT NOT NULL,
  cleaner TEXT NOT NULL,                    -- checked in code (lib/clean/cleaners.ts): a new cleaner needs no rebuild
  options TEXT NOT NULL DEFAULT '{}',       -- JSON, e.g. {"phoneFormat":"e164"}
  fill_status TEXT NOT NULL DEFAULT 'filling' CHECK (fill_status IN ('filling', 'done', 'failed')),
  fill_cursor INTEGER NOT NULL DEFAULT 0,
  filled_rows INTEGER NOT NULL DEFAULT 0,   -- the last fill: cells it left holding a value
  blanked_rows INTEGER NOT NULL DEFAULT 0,  -- the last fill: source values the cleaner couldn't read
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(sheet_id, column_name)
);
CREATE INDEX idx_clean_columns_user ON clean_columns(user_id);
CREATE INDEX idx_clean_columns_filling ON clean_columns(fill_status) WHERE fill_status = 'filling';
