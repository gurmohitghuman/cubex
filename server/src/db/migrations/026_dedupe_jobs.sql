-- Removing duplicate rows (services/dedupe-remove.ts) deletes rows in slices,
-- so a restart can stop it halfway. The rows to delete are journaled before
-- any is deleted, and boot finishes the job; one still 'planning' deleted
-- nothing and is dropped. Both tables are empty when Cubex is idle.
CREATE TABLE dedupe_jobs (
  sheet_id  TEXT PRIMARY KEY REFERENCES sheets(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Rows at this position or above were appended during the job: never deleted.
  floor     INTEGER NOT NULL,
  row_count INTEGER NOT NULL,
  stage     TEXT NOT NULL CHECK (stage IN ('planning', 'deleting'))
);

-- The rows to delete: `plan` is a Float64Array of rowids, ascending. A chunk's
-- record is deleted in the same transaction as its rows, so a restart never
-- deletes a chunk twice (SQLite may give a deleted row's rowid to a new row).
CREATE TABLE dedupe_chunks (
  sheet_id TEXT NOT NULL REFERENCES dedupe_jobs(sheet_id) ON DELETE CASCADE,
  chunk    INTEGER NOT NULL,
  plan     BLOB NOT NULL,
  PRIMARY KEY (sheet_id, chunk)
) WITHOUT ROWID;
