-- Deleting or renaming a column strips a key from every row, in slices between
-- requests (lib/column-purge.ts). A strip in progress is recorded here, so a
-- restart finishes it, and the background column check (lib/column-repair.ts)
-- never mistakes the leftover keys for a column that should be listed.
CREATE TABLE column_purges (
  sheet_id    TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  column_name TEXT NOT NULL,
  PRIMARY KEY (sheet_id, column_name)
);
