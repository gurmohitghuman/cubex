-- Auto-dedupe (services/auto-dedupe-*.ts): a sheet setting that keeps one row
-- per key as rows arrive. A row is checked when it arrives with a key (a
-- webhook delivery, append_rows, a CSV import, list rows, transfer_rows) or
-- when a person or an agent types a new key into it; when other rows already
-- hold that key, the oldest (or newest) of them stays and the others go to
-- the trash. Keys are the key column's values read the way Remove duplicates
-- reads them (lib/dedupe/key.ts); blank keys and cells over 200 characters
-- never match.
--
-- A batch of rows in the trash gets rows added later (auto-dedupe's batch of
-- the day): seq_high is the highest seq it has ever given, so a seq handed
-- out (an answer's, a toast's) never means another row after a partial restore
-- took the last ones out (lib/trash/move.ts).
ALTER TABLE trash_items ADD COLUMN seq_high INTEGER NOT NULL DEFAULT 0;

-- One setting per sheet. The id is never reused (AUTOINCREMENT): its keys
-- belong to it, and a dropped setting's keys are deleted later, in slices
-- (auto_dedupe_purges), so they can never be taken for a newer one's. Another
-- key column or match is a new setting; keep is changed in place.
CREATE TABLE auto_dedupe (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sheet_id TEXT NOT NULL UNIQUE REFERENCES sheets(id) ON DELETE CASCADE,
  column_name TEXT NOT NULL,
  path TEXT NOT NULL,                       -- the column's JSON path in rows.data, which the triggers read
  match TEXT NOT NULL CHECK (match IN ('text', 'email', 'domain', 'phone', 'company', 'person_name')),
  phone_country TEXT,                       -- match phone: how bare digits are read
  keep TEXT NOT NULL CHECK (keep IN ('oldest', 'newest')),
  build_cursor INTEGER DEFAULT 0,           -- the rowid its keys are built to; NULL once built
  shared_rows INTEGER,                      -- once built: rows that already shared a key with an older row
  removed_rows INTEGER NOT NULL DEFAULT 0,  -- rows it has sent to the trash
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_auto_dedupe_user ON auto_dedupe(user_id);

-- Each row's key (rid is rows.rowid; a row with no key has no entry). No
-- user_id and no foreign key: every read goes through its setting, and a
-- dropped setting's keys go in slices.
CREATE TABLE auto_dedupe_keys (
  dedupe_id INTEGER NOT NULL,
  rid INTEGER NOT NULL,
  key TEXT NOT NULL,
  PRIMARY KEY (dedupe_id, rid)
) WITHOUT ROWID;
CREATE INDEX idx_auto_dedupe_keys_key ON auto_dedupe_keys(dedupe_id, key, rid);

-- Rows written since their key was read: the triggers below add them, in the
-- writer's own transaction, on every connection (run workers included).
CREATE TABLE auto_dedupe_dirty (
  dedupe_id INTEGER NOT NULL,
  rid INTEGER NOT NULL,
  PRIMARY KEY (dedupe_id, rid)
) WITHOUT ROWID;

-- Checks still to make, as ranges of rowids (lo..hi): rows that arrived while
-- the keys were being built or brought up to date, a CSV import's rows, and
-- checks whose losing row a run or another job held at the time (those wait
-- until retry_at, ms since epoch, so they don't hold up the rest).
CREATE TABLE auto_dedupe_checks (
  dedupe_id INTEGER NOT NULL,
  lo INTEGER NOT NULL,
  hi INTEGER NOT NULL,
  retry_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (dedupe_id, lo)
) WITHOUT ROWID;

-- Dropped settings whose keys, change log and checks are still being deleted.
CREATE TABLE auto_dedupe_purges (
  dedupe_id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The triggers use built-in SQL only (trusted_schema is OFF, and no script or
-- worker connection registers app functions). A sheet without the setting
-- pays one probe of auto_dedupe's sheet_id index per row written.
-- A new row without a value in the key column has no key: nothing to read.
CREATE TRIGGER auto_dedupe_rows_insert AFTER INSERT ON rows
WHEN EXISTS (SELECT 1 FROM auto_dedupe a WHERE a.sheet_id = NEW.sheet_id
  AND IFNULL(json_extract(NEW.data, a.path), '') <> '')
BEGIN
  INSERT OR IGNORE INTO auto_dedupe_dirty (dedupe_id, rid)
    SELECT id, NEW.rowid FROM auto_dedupe WHERE sheet_id = NEW.sheet_id;
END;

-- Only when the key column's value changed: a run writing another column, or
-- a rename copying a key, logs nothing.
CREATE TRIGGER auto_dedupe_rows_data AFTER UPDATE OF data ON rows
WHEN EXISTS (SELECT 1 FROM auto_dedupe a WHERE a.sheet_id = NEW.sheet_id
  AND json_extract(OLD.data, a.path) IS NOT json_extract(NEW.data, a.path))
BEGIN
  INSERT OR IGNORE INTO auto_dedupe_dirty (dedupe_id, rid)
    SELECT id, NEW.rowid FROM auto_dedupe WHERE sheet_id = NEW.sheet_id;
END;

-- A row gone takes its key with it at once: a rowid SQLite gives a new row
-- later must never inherit it.
CREATE TRIGGER auto_dedupe_rows_delete AFTER DELETE ON rows
WHEN EXISTS (SELECT 1 FROM auto_dedupe WHERE sheet_id = OLD.sheet_id)
BEGIN
  DELETE FROM auto_dedupe_keys WHERE rid = OLD.rowid
    AND dedupe_id = (SELECT id FROM auto_dedupe WHERE sheet_id = OLD.sheet_id);
  DELETE FROM auto_dedupe_dirty WHERE rid = OLD.rowid
    AND dedupe_id = (SELECT id FROM auto_dedupe WHERE sheet_id = OLD.sheet_id);
END;

-- A setting turned off, replaced, or gone with its sheet: its keys go later, in slices.
CREATE TRIGGER auto_dedupe_delete AFTER DELETE ON auto_dedupe
BEGIN
  INSERT OR IGNORE INTO auto_dedupe_purges (dedupe_id) VALUES (OLD.id);
END;
