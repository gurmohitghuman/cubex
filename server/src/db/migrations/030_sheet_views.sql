-- Saved views (services/views.ts): per sheet, a name, an optional description,
-- its filters and its hidden columns. Never a sort (sort is a one-time physical
-- reorder) and never a column order (column_order is the registry).
-- Every sheet has one Default view (is_default), which can't be deleted.
--
-- The ACTIVE view's filters live on the sheet itself (sheets.empty_filter,
-- column_filters, row_filter), where every reader already finds them; its own
-- filter fields here are NULL. Every other view keeps its filters here, and
-- switching views swaps them in one transaction. hidden_columns always lives
-- here. Column rename/delete rewrite both places (lib/views/refs.ts).
CREATE TABLE sheet_views (
  id TEXT PRIMARY KEY,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  empty_filter TEXT,                        -- JSON, as sheets.empty_filter
  column_filters TEXT,                      -- JSON, as sheets.column_filters
  row_filter TEXT,                          -- JSON, as sheets.row_filter
  hidden_columns TEXT,                      -- JSON list of column names
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_sheet_views_name_ci ON sheet_views(sheet_id, LOWER(name));
CREATE UNIQUE INDEX idx_sheet_views_default ON sheet_views(sheet_id) WHERE is_default = 1;
CREATE INDEX idx_sheet_views_user ON sheet_views(user_id);

-- Filters the per-column ones can't hold (lib/row-filter/where.ts items): a
-- run-state check on any run column ("Rows with errors"), OR groups, or a
-- second condition on one column. Part of the active view, like the other two.
ALTER TABLE sheets ADD COLUMN row_filter TEXT;
ALTER TABLE sheets ADD COLUMN active_view_id TEXT;

-- A Default view for every sheet there is, holding what the sheet shows today.
INSERT INTO sheet_views (id, sheet_id, user_id, name, is_default, position)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4'
    || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1)
    || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  id, user_id, 'Default', 1, 0
FROM sheets;
UPDATE sheets SET active_view_id = (
  SELECT v.id FROM sheet_views v WHERE v.sheet_id = sheets.id AND v.is_default = 1
);
