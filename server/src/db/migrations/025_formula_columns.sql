-- Formula columns (services/formula-column.ts): a column filled for free from
-- other columns of its row by a JavaScript expression (lib/formula/), run in
-- the QuickJS sandbox, never the server's own eval. Kept by column name, as
-- clean columns are: a rename rewrites the formula's {{references}} and
-- `inputs`, a delete forgets the record (lib/formula-columns.ts). The fill
-- runs in slices with the sheet busy and keeps its place in fill_cursor (rows
-- up to that rowid are done), so a restart finishes it (services/
-- derived-fill.ts). Auto-run on a formula column is an autorun_columns entry
-- of kind 'formula' that follows the inputs (services/derived-follow.ts).
CREATE TABLE formula_columns (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  column_name TEXT NOT NULL,
  formula TEXT NOT NULL,                    -- as written, every {{reference}} naming its column exactly
  inputs TEXT NOT NULL DEFAULT '[]',        -- JSON: the columns it reads, in compiled order
  description TEXT,                         -- the plain words an AI wrote it from, when it did
  fill_status TEXT NOT NULL DEFAULT 'filling' CHECK (fill_status IN ('filling', 'done', 'failed')),
  fill_cursor INTEGER NOT NULL DEFAULT 0,
  filled_rows INTEGER NOT NULL DEFAULT 0,   -- the last fill: cells holding a result
  error_rows INTEGER NOT NULL DEFAULT 0,    -- the last fill: rows showing "❌ <the error>"
  first_error TEXT,                         -- the first of them, "Row N: <the error>"
  error_message TEXT,                       -- why the fill failed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(sheet_id, column_name)
);
CREATE INDEX idx_formula_columns_user ON formula_columns(user_id);
CREATE INDEX idx_formula_columns_filling ON formula_columns(fill_status) WHERE fill_status = 'filling';
