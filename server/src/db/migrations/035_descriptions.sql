-- Descriptions: a few words a person or an agent writes about a sheet or a
-- column, shown in the app and returned by get_sheet (never sent to AI). A
-- column's is kept by the column's name, as the clean, formula and lookup
-- records are (lib/column-descriptions.ts): a rename carries it, a delete drops
-- it, and a CSV replace or an undone import forgets the ones whose column is gone.
ALTER TABLE sheets ADD COLUMN description TEXT;

CREATE TABLE column_descriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  column_name TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(sheet_id, column_name)
);
CREATE INDEX idx_column_descriptions_user ON column_descriptions(user_id);
