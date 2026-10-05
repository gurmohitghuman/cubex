-- Big-sheet jobs run in slices between requests (lib/slices.ts), so a restart
-- can stop one halfway. Each job leaves a record here while it runs, and boot
-- finishes or undoes it from that record. Every table is empty when Cubex is idle.

-- An AI/HTTP run writes the '⏳ Processing...' placeholder into its target rows
-- at start, and a cancelled or failed run has its leftover placeholders cleared,
-- both in slices (lib/placeholder-cells.ts). 'seeding': the run is not queued
-- yet, so boot fails it rather than resume a half-seeded run. 'clearing': the
-- run has ended and its placeholders are still being cleared; boot finishes
-- that, and a sort waits for it because it moves the rows being cleared.
ALTER TABLE ai_runs ADD COLUMN placeholder_work TEXT CHECK (placeholder_work IN ('seeding', 'clearing'));
ALTER TABLE http_runs ADD COLUMN placeholder_work TEXT CHECK (placeholder_work IN ('seeding', 'clearing'));

-- A physical sort in progress (services/sheet-sort.ts). Rows move to
-- base + new position, results follow, then rows move down to 0…n-1; `stage`
-- says which step is under way, and the plan is in sort_chunks.
CREATE TABLE sort_jobs (
  sheet_id  TEXT PRIMARY KEY REFERENCES sheets(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  base      INTEGER NOT NULL,
  row_count INTEGER NOT NULL,
  stage     TEXT NOT NULL CHECK (stage IN ('planning', 'moving', 'parking', 'mapping', 'shifting'))
);

-- The plan in row-storage order, a few thousand rows per chunk: `plan` is a
-- Float64Array of (rowid, old position, new position) triples (lib/sort-plan.ts).
CREATE TABLE sort_chunks (
  sheet_id TEXT NOT NULL REFERENCES sort_jobs(sheet_id) ON DELETE CASCADE,
  chunk    INTEGER NOT NULL,
  plan     BLOB NOT NULL,
  PRIMARY KEY (sheet_id, chunk)
) WITHOUT ROWID;

-- A CSV import in progress (services/csv-import.ts). Its rows go in at
-- first_row up to (not including) end_row, and appends from elsewhere land at
-- end_row or above. Boot removes the rows of an interrupted import; for a
-- replace, the sheet is left empty with the file's columns.
CREATE TABLE import_jobs (
  sheet_id   TEXT PRIMARY KEY REFERENCES sheets(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_replace INTEGER NOT NULL,
  first_row  INTEGER NOT NULL,
  end_row    INTEGER NOT NULL,
  columns    TEXT NOT NULL
);
