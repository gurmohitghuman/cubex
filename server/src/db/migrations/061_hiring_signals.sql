-- Every result key a keep-mode list run added to a sheet (lib/enrich-list.ts
-- `keep`, services/enrich-list-seen.ts): a rerun adds only results never seen
-- there. Kept apart from the rows, so a row deleted since stays out, emptying
-- the trash forgets nothing and an edited cell changes nothing. last_seen_at:
-- when a run last found it again.
CREATE TABLE enrichment_list_seen (
  dest_sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  first_run_id TEXT,                    -- plain id: the run can go while what it found stays seen
  PRIMARY KEY (dest_sheet_id, dedupe_key)
) WITHOUT ROWID;

-- A hiring table (services/hiring-*.ts, lib/hiring/): a table Cubex made to
-- find the companies hiring for chosen roles. Its Searches sheet holds one
-- row per role title and a list enrichment set up and not run (setup_only 2,
-- as migration 046's engines) that adds the roles found to its Roles sheet in
-- keep mode; each check sums them up per company on its Companies sheet. This
-- row holds what the table was made from.
CREATE TABLE hiring_signals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  companies_sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  roles_sheet_id TEXT REFERENCES sheets(id) ON DELETE SET NULL,
  searches_sheet_id TEXT REFERENCES sheets(id) ON DELETE SET NULL,
  roles TEXT NOT NULL,                  -- JSON array: the role titles it was made with
  country TEXT,                         -- ISO alpha-2, or null: any country
  place TEXT,
  posted_within_days INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_hiring_signals_companies ON hiring_signals(companies_sheet_id);
CREATE INDEX idx_hiring_signals_user ON hiring_signals(user_id, table_id);

-- Each check of a hiring table (services/hiring-check.ts): the search (one
-- paid run, started only when asked), then the summary per company (free).
-- Journaled stage by stage: a restart waits for the run it started, then sums
-- up; it never starts a search on its own. At most one check of a table goes
-- at a time (the partial index).
CREATE TABLE hiring_checks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  signal_id TEXT NOT NULL REFERENCES hiring_signals(id) ON DELETE CASCADE,
  label TEXT NOT NULL,                  -- the asker's day (YYYY-MM-DD): the roles' and new companies' First seen
  since_label TEXT,                     -- the day of the check before, which "New since" names (null: the first)
  stage TEXT NOT NULL CHECK (stage IN ('searching', 'summarizing', 'done', 'stopped')),
  run_id TEXT,                          -- the search's run (null: it didn't start)
  searches INTEGER NOT NULL DEFAULT 0,
  roles_added INTEGER NOT NULL DEFAULT 0,
  companies_new INTEGER NOT NULL DEFAULT 0,    -- companies first seen in this check
  companies_hiring_more INTEGER NOT NULL DEFAULT 0, -- companies seen before with roles new in this check
  problems TEXT NOT NULL DEFAULT '[]',  -- what didn't go to plan, in plain words
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_hiring_checks ON hiring_checks(signal_id, created_at);
CREATE UNIQUE INDEX idx_hiring_checks_going ON hiring_checks(signal_id) WHERE stage IN ('searching', 'summarizing');
