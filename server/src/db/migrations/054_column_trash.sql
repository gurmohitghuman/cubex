-- cube:foreign-keys-off
-- (Rebuilds a table: migrate.ts runs this file with foreign keys off, as
-- SQLite's ALTER TABLE docs require, and checks them before committing.)
--
-- A deleted column goes to the trash (services/column-trash*.ts,
-- trash-restore-column.ts): one trash item of kind 'column'. Restoring it
-- brings back its cells, its place among the columns, its description and its
-- own setup (what makes it an AI, HTTP API, enrichment, waterfall, formula,
-- lookup or clean column), under a new name when its old one is taken. What
-- other columns, views and settings said about it is cleaned up by the delete
-- as before and doesn't come back: the item lists each of those so the
-- restore can name them.
--
-- SQLite can't change a CHECK in place, so trash_items is rebuilt with 'column'
-- among its kinds. Every item keeps its id, and the AUTOINCREMENT sequence is
-- carried over (an id is never reused: a purge in slices must never meet a
-- newer item's rows), with the three indexes 036 made.
--
-- The cells go in trash_rows, one row per sheet row that held a value (an
-- empty cell isn't kept): its stable row id, its place then (row_index, shown
-- when looking inside) and `data` holding only that cell, {"<name>": value}.
-- So looking inside, searching, the CSV download and the purge in slices read
-- a column item the way they read a batch of rows, with no second store to
-- keep in step. A restore finds each row by its stable id; a cell whose row
-- is gone then (deleted since, maybe in the trash itself) stays in the item,
-- and restoring the item again puts it into the column once its row is back.
--
-- The cells move from the rows in slices, each slice copying and removing in
-- one transaction, by the column delete's own strip: column_purges.trash_id
-- names the item the strip fills, so the boot resume that finishes a strip
-- (resumeColumnPurges) finishes the move. The item is 'moving' until its last
-- slice seals it 'kept'.
CREATE TABLE trash_items_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('rows', 'sheet', 'table', 'column')),
  table_id TEXT NOT NULL,
  sheet_id TEXT,                            -- 'rows', 'sheet' and 'column'
  table_name TEXT NOT NULL,
  sheet_name TEXT,
  how TEXT NOT NULL,                        -- also 'column': a column deleted
  via TEXT NOT NULL,
  token_name TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,     -- 'column': the cells it holds (rows that had a value)
  bytes INTEGER NOT NULL DEFAULT 0,         -- 'rows' and 'column': the size of their cells
  columns TEXT NOT NULL DEFAULT '[]',       -- 'column': its name, alone
  row_generation INTEGER,
  top_index INTEGER,
  state TEXT NOT NULL DEFAULT 'kept' CHECK (state IN ('moving', 'kept', 'restoring', 'purging')),
  restore_at INTEGER,
  restored INTEGER NOT NULL DEFAULT 0,      -- 'column': cells written back so far
  deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
  seq_high INTEGER NOT NULL DEFAULT 0,
  -- 'column' only:
  column_name TEXT,                         -- its name when deleted
  column_position INTEGER,                  -- its place in column_order then (0 is first)
  column_setup TEXT,                        -- JSON: its description, its own setup and auto-run, as stored
  column_dropped TEXT,                      -- JSON: what referred to it and was cleaned up
  restore_name TEXT,                        -- restoring: the name it comes back under; kept: the column its
                                            -- other cells went back to (these ones' rows were gone then)
  restore_skipped INTEGER NOT NULL DEFAULT 0, -- restoring: cells whose row is gone (they stay in the item)
  restore_kept INTEGER NOT NULL DEFAULT 0,  -- restoring: cells left out, the row holds a value there now
  restore_keys INTEGER NOT NULL DEFAULT 0,  -- restoring: 1 when the caller may use saved API keys (an HTTP
                                            -- setup put back keeps reading them; a resume writes the same)
  restore_cursor INTEGER NOT NULL DEFAULT 0, -- restoring: the last seq gone through
  restore_into INTEGER NOT NULL DEFAULT 0   -- restoring: 1 when the cells go into that column, already there
);

INSERT INTO trash_items_new (id, user_id, kind, table_id, sheet_id, table_name, sheet_name, how, via, token_name,
  row_count, bytes, columns, row_generation, top_index, state, restore_at, restored, deleted_at, seq_high)
SELECT id, user_id, kind, table_id, sheet_id, table_name, sheet_name, how, via, token_name,
  row_count, bytes, columns, row_generation, top_index, state, restore_at, restored, deleted_at, seq_high
FROM trash_items;

-- The sequence as it was (it can be past every id left, when the newest items
-- were purged), never below the ids copied.
DELETE FROM sqlite_sequence WHERE name = 'trash_items_new';
INSERT INTO sqlite_sequence (name, seq)
SELECT 'trash_items_new', MAX(IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'trash_items'), 0),
  IFNULL((SELECT MAX(id) FROM trash_items_new), 0));

DROP TABLE trash_items;
ALTER TABLE trash_items_new RENAME TO trash_items;

CREATE INDEX idx_trash_items_user ON trash_items(user_id, deleted_at);
CREATE INDEX idx_trash_items_sheet ON trash_items(sheet_id) WHERE sheet_id IS NOT NULL;
CREATE INDEX idx_trash_items_table ON trash_items(table_id);

-- A column delete's strip moves the cells into this item (NULL: they go at
-- once, as a rename's strip of the old key does, or with the trash kept 0 days).
ALTER TABLE column_purges ADD COLUMN trash_id INTEGER;
