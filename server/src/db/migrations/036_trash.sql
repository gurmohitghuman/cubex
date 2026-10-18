-- The trash (services/trash-*.ts): what is deleted is kept for the days set in
-- Settings (settings.trash_days, 0-90; 0 deletes at once), then deleted for
-- good, in slices.
--
-- Rows deleted from a sheet (the grid, delete_rows, removing duplicates, a CSV
-- import that replaces the rows, rows moved out with transfer_rows) move into
-- trash_rows, one batch (trash item) per deletion. A deleted sheet or table
-- stays where it is, hidden: sheets.trash_id / tables.trash_id name the trash
-- item that holds it (a deleted table's sheets carry the table's item), and
-- every read of a sheet or a table passes over them. A restore clears it, the
-- purge deletes the sheet or table.
ALTER TABLE settings ADD COLUMN trash_days INTEGER NOT NULL DEFAULT 30;

ALTER TABLE tables ADD COLUMN trash_id INTEGER;
ALTER TABLE sheets ADD COLUMN trash_id INTEGER;

-- Names are unique among live tables and sheets only: a deleted one doesn't
-- hold its name, and a restore whose name was taken meanwhile gets a new one.
DROP INDEX idx_tables_user_name;
CREATE UNIQUE INDEX idx_tables_user_name ON tables(user_id, name) WHERE trash_id IS NULL;
DROP INDEX idx_sheets_table_name_ci;
CREATE UNIQUE INDEX idx_sheets_table_name_ci ON sheets(table_id, LOWER(name)) WHERE trash_id IS NULL;
CREATE INDEX idx_tables_trash ON tables(trash_id) WHERE trash_id IS NOT NULL;
CREATE INDEX idx_sheets_trash ON sheets(trash_id) WHERE trash_id IS NOT NULL;

-- One deletion. The id is never reused (AUTOINCREMENT): a purge in slices must
-- never meet a newer item's rows.
CREATE TABLE trash_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('rows', 'sheet', 'table')),
  table_id TEXT NOT NULL,                   -- no foreign keys: the purge deletes the sheet or table itself
  sheet_id TEXT,                            -- 'rows' and 'sheet'
  table_name TEXT NOT NULL,                 -- the names when it was deleted
  sheet_name TEXT,
  how TEXT NOT NULL,                        -- grid, api, duplicates, import, transfer, sheet, table
  via TEXT NOT NULL,                        -- app, api, mcp or cubex (lib/actor.ts)
  token_name TEXT,                          -- the access token's name, over the API or MCP
  row_count INTEGER NOT NULL DEFAULT 0,     -- rows in it (a sheet's or table's when deleted)
  bytes INTEGER NOT NULL DEFAULT 0,         -- 'rows': the size of their cells
  columns TEXT NOT NULL DEFAULT '[]',       -- 'rows': the sheet's columns when they were deleted
  row_generation INTEGER,                   -- 'rows': the sheet's row_generation once they were gone
  top_index INTEGER,                        -- 'rows': the highest old position among them
  -- moving: rows still going in (a journaled removal or import finishes it);
  -- restoring: rows going back (restore_at: where they go at the end, NULL
  -- for their old places; restored: how many are back); purging: going for good.
  state TEXT NOT NULL DEFAULT 'kept' CHECK (state IN ('moving', 'kept', 'restoring', 'purging')),
  restore_at INTEGER,
  restored INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_trash_items_user ON trash_items(user_id, deleted_at);
CREATE INDEX idx_trash_items_sheet ON trash_items(sheet_id) WHERE sheet_id IS NOT NULL;
CREATE INDEX idx_trash_items_table ON trash_items(table_id);

-- A batch's rows: each one's stable id, old position and cells; seq keeps
-- their order. No user_id and no foreign key: every read goes through its
-- item (and that item's user_id), and a purge deletes them in slices.
CREATE TABLE trash_rows (
  item_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  row_index INTEGER NOT NULL,
  row_id TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (item_id, seq)
);
