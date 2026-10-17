-- Lookup columns (services/lookup-column.ts): a column filled for free from
-- another sheet, by matching a column of this row against a column there
-- (equals, or contains), then writing a column of the first match, yes/no, a
-- count, or the matches as a JSON list. Kept by column name, as clean and
-- formula columns are: renames rewrite the record, a delete of its own column
-- forgets it (lib/lookup-columns.ts). The fill runs in slices with the sheet
-- busy and keeps its place in fill_cursor (services/derived-fill.ts); auto-run
-- is an autorun_columns entry of kind 'lookup' that follows source_column.
-- Changes in the other sheet don't work rows out again ("look up again" does).
-- Renaming the other sheet's columns rewrites the record; deleting the other
-- sheet, or a column of it the lookup reads, sets `broken` and the lookup
-- stops with that message.
CREATE TABLE lookup_columns (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  column_name TEXT NOT NULL,
  source_column TEXT NOT NULL,              -- this row's value
  other_sheet_id TEXT NOT NULL,             -- the sheet it looks in (no foreign key: see lookup_sheet_delete)
  match_column TEXT NOT NULL,               -- the column there it matches
  match_mode TEXT NOT NULL CHECK (match_mode IN ('equals', 'contains')),
  returns TEXT NOT NULL CHECK (returns IN ('value', 'exists', 'count', 'list')),
  return_columns TEXT,                      -- JSON list of columns there: one for 'value'; for 'list', NULL = all
  list_limit INTEGER NOT NULL DEFAULT 10,   -- 'list': at most this many matches (1-100)
  broken TEXT,                              -- why it can't look up any more, or NULL
  fill_status TEXT NOT NULL DEFAULT 'filling' CHECK (fill_status IN ('filling', 'done', 'failed')),
  fill_cursor INTEGER NOT NULL DEFAULT 0,
  filled_rows INTEGER NOT NULL DEFAULT 0,   -- the last fill: cells holding a result
  error_rows INTEGER NOT NULL DEFAULT 0,    -- the last fill: rows showing "❌ <why>"
  first_error TEXT,                         -- the first of them, "Row N: <why>"
  error_message TEXT,                       -- why the fill failed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(sheet_id, column_name)
);
CREATE INDEX idx_lookup_columns_user ON lookup_columns(user_id);
CREATE INDEX idx_lookup_columns_other ON lookup_columns(other_sheet_id, match_column);
CREATE INDEX idx_lookup_columns_filling ON lookup_columns(fill_status) WHERE fill_status = 'filling';

-- A looked-up column (services/lookup-source.ts): one per column of another
-- sheet that lookups match against, shared by them all, dropped when none does.
-- Its keys are built in slices (build_cursor: the rowid reached, NULL once
-- built) and kept current through lookup_dirty. A sort moves rows: the trigger
-- sets order_dirty, and the keys' row positions are read again in slices
-- (order_cursor: the rid reached, NULL when that isn't running). The ids are
-- never reused (AUTOINCREMENT): a dropped source's keys are deleted later, in
-- slices (lookup_purges), and must never be taken for a new one's.
CREATE TABLE lookup_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  sheet_id TEXT NOT NULL,                   -- the looked-up sheet (no foreign key: see lookup_sheet_delete)
  column_name TEXT NOT NULL,
  path TEXT NOT NULL,                       -- the column's JSON path in rows.data, which the triggers read
  with_text INTEGER NOT NULL DEFAULT 0,     -- 1: also in lookup_text, for contains
  build_cursor INTEGER DEFAULT 0,
  order_dirty INTEGER NOT NULL DEFAULT 0,
  order_cursor INTEGER,
  version INTEGER NOT NULL DEFAULT 0,       -- moves whenever a key changes (answers cached per version)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(sheet_id, column_name)
);

-- Each row's key in a looked-up column: the value trimmed, Unicode-normalized
-- and lowercased in JavaScript (lib/lookup/normalize.ts), a long one hashed.
-- rid is rows.rowid. No user_id: every read goes through a source_id read
-- with its user_id. No foreign key to lookup_sources: a dropped source's keys
-- go in slices, never in one cascade.
CREATE TABLE lookup_keys (
  source_id INTEGER NOT NULL,
  rid INTEGER NOT NULL,
  row_index INTEGER NOT NULL,
  key TEXT NOT NULL,
  text TEXT,                                -- what lookup_text holds for the row, when that isn't `key`
  PRIMARY KEY (source_id, rid)
) WITHOUT ROWID;
CREATE INDEX idx_lookup_keys_key ON lookup_keys(source_id, key, row_index);

-- Contains: every trigram of each value of a with_text source, rowid =
-- source_id * 2^40 + rid. Contentless: a delete names the text it removes
-- (lookup_keys keeps it), the cheap way to remove a row (contentless_delete
-- tombstones stalled for seconds on mass deletes).
CREATE VIRTUAL TABLE lookup_text USING fts5(t, tokenize = 'trigram case_sensitive 1', content = '');

-- Rows of a looked-up sheet written since their keys were last read: the
-- triggers below add them, in the writer's own transaction, on every
-- connection (run workers included). A lookup reads them again before it
-- matches (services/lookup-maintain.ts).
CREATE TABLE lookup_dirty (
  sheet_id TEXT NOT NULL,
  rid INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (sheet_id, rid)
) WITHOUT ROWID;

-- Dropped sources whose keys are still being deleted (services/lookup-purge.ts).
CREATE TABLE lookup_purges (
  source_id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  sheet_id TEXT NOT NULL,
  with_text INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The triggers use built-in SQL only (trusted_schema is OFF, and no script or
-- worker connection registers app functions). A sheet nobody looks up pays one
-- probe of lookup_sources' (sheet_id, column_name) index per row written.
CREATE TRIGGER lookup_rows_insert AFTER INSERT ON rows
WHEN EXISTS (SELECT 1 FROM lookup_sources WHERE sheet_id = NEW.sheet_id)
BEGIN
  INSERT OR IGNORE INTO lookup_dirty (sheet_id, rid, user_id) VALUES (NEW.sheet_id, NEW.rowid, NEW.user_id);
END;

-- Only when a looked-up column's value changed: a run writing another column,
-- or a rename copying a key, logs nothing.
CREATE TRIGGER lookup_rows_data AFTER UPDATE OF data ON rows
WHEN EXISTS (SELECT 1 FROM lookup_sources s WHERE s.sheet_id = NEW.sheet_id
  AND json_extract(OLD.data, s.path) IS NOT json_extract(NEW.data, s.path))
BEGIN
  INSERT OR IGNORE INTO lookup_dirty (sheet_id, rid, user_id) VALUES (NEW.sheet_id, NEW.rowid, NEW.user_id);
END;

-- A sort: the first row it moves flags the sheet's sources once.
CREATE TRIGGER lookup_rows_order AFTER UPDATE OF row_index ON rows
WHEN EXISTS (SELECT 1 FROM lookup_sources WHERE sheet_id = NEW.sheet_id AND order_dirty = 0)
BEGIN
  UPDATE lookup_sources SET order_dirty = 1 WHERE sheet_id = NEW.sheet_id AND order_dirty = 0;
END;

CREATE TRIGGER lookup_rows_delete AFTER DELETE ON rows
WHEN EXISTS (SELECT 1 FROM lookup_sources WHERE sheet_id = OLD.sheet_id)
BEGIN
  INSERT OR IGNORE INTO lookup_dirty (sheet_id, rid, user_id) VALUES (OLD.sheet_id, OLD.rowid, OLD.user_id);
END;

-- A deleted sheet (on its own, or with its table): lookups into it stop with a
-- message, and its sources go BEFORE its rows do, so their delete logs nothing.
CREATE TRIGGER lookup_sheet_delete BEFORE DELETE ON sheets
BEGIN
  UPDATE lookup_columns SET broken = 'The sheet "' || OLD.name || '" it looks in was deleted.',
    updated_at = datetime('now')
  WHERE other_sheet_id = OLD.id AND broken IS NULL;
  DELETE FROM lookup_sources WHERE sheet_id = OLD.id;
END;

-- A dropped source's keys are deleted later, in slices.
CREATE TRIGGER lookup_source_delete AFTER DELETE ON lookup_sources
BEGIN
  INSERT OR IGNORE INTO lookup_purges (source_id, user_id, sheet_id, with_text)
    VALUES (OLD.id, OLD.user_id, OLD.sheet_id, OLD.with_text);
END;

-- A lookup column gone (deleted, or with its sheet or table): a source no
-- other lookup reads goes too.
CREATE TRIGGER lookup_column_delete AFTER DELETE ON lookup_columns
BEGIN
  DELETE FROM lookup_sources WHERE sheet_id = OLD.other_sheet_id AND column_name = OLD.match_column
    AND NOT EXISTS (SELECT 1 FROM lookup_columns WHERE other_sheet_id = OLD.other_sheet_id
      AND match_column = OLD.match_column);
END;
