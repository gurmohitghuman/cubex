-- Out of date follows what each result was made from (lib/run-inputs). A run's
-- stamp in rows.run_inputs names the list of columns it read, "<set id>:<fp>",
-- and a reader checks each row against its own list: a setup that reads other
-- columns leaves the results made before it as they were (a setup change never
-- marks rows out of date; only a change to a row's input cells does). One row
-- per run column key and list. AUTOINCREMENT never reuses an id, so a stamp
-- never reads against another list. columns: a JSON array of column names in
-- the run's order, null for an input whose column wasn't there; a rename
-- rewrites it. Scoped by user_id and its key, which goes with its column.
CREATE TABLE run_input_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key INTEGER NOT NULL REFERENCES run_input_keys(id) ON DELETE CASCADE,
  columns TEXT NOT NULL
);
CREATE INDEX idx_run_input_sets_key ON run_input_sets(key, id);
CREATE INDEX idx_run_input_sets_user ON run_input_sets(user_id);

-- A stamp written before this migration names no list: it reads as it did,
-- against the columns of the run that was its column's newest here (an AI run
-- wins over an HTTP one of the same name, as in lib/column-types.ts). The boot
-- that follows turns that run's columns into the key's legacy_set, a list as
-- any other (renames rewrite it), and clears the two run ids
-- (lib/run-inputs/legacy.ts). NULL legacy_set: such stamps never read out of date.
ALTER TABLE run_input_keys ADD COLUMN legacy_set INTEGER;
ALTER TABLE run_input_keys ADD COLUMN legacy_ai_run TEXT;
ALTER TABLE run_input_keys ADD COLUMN legacy_http_run TEXT;
UPDATE run_input_keys SET
  legacy_ai_run = (SELECT a.id FROM ai_runs a WHERE a.sheet_id = run_input_keys.sheet_id
    AND a.user_id = run_input_keys.user_id AND a.column_name = run_input_keys.column_name
    ORDER BY a.rowid DESC LIMIT 1),
  legacy_http_run = (SELECT h.id FROM http_runs h WHERE h.rowid = (SELECT MAX(rowid) FROM http_runs
    WHERE sheet_id = run_input_keys.sheet_id AND master_column_name = run_input_keys.column_name)
    AND h.user_id = run_input_keys.user_id);
