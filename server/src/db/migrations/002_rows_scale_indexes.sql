-- cube:foreign-keys-off
-- (Rebuilds a table: migrate.ts runs this file with foreign keys off, as
-- SQLite's ALTER TABLE docs require, and checks them before committing.
-- With them on, dropping the old table would null webhook_deliveries.row_id.)
--
-- Sheets with a million rows. Page reads and row counts filter on
-- (sheet_id, user_id) and order by row_index, so one unique index on all three
-- lets SQLite page, skip OFFSET rows and count from the index alone, instead of
-- reading each row's data to check user_id (a page 500,000 rows deep: 0.9 s to
-- milliseconds). It replaces UNIQUE(sheet_id, row_index) rather than sitting
-- next to it, because every index holding row_index is rewritten for every row
-- a sort or import moves. idx_rows_sheet (a prefix of it) and idx_rows_user
-- (the single account's id on every row, which SQLite picked for sheet queries
-- on a fresh install without statistics) go with the old table.
CREATE TABLE rows_new (
  id TEXT PRIMARY KEY,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',          -- JSON object: { "columnName": "value", ... }
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(sheet_id, user_id, row_index)
);
INSERT INTO rows_new (rowid, id, sheet_id, user_id, row_index, data, updated_at)
  SELECT rowid, id, sheet_id, user_id, row_index, data, updated_at FROM rows;
DROP TABLE rows;
ALTER TABLE rows_new RENAME TO rows;
