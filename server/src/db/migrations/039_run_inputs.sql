-- Out of date (lib/run-inputs): what each row's run result was made from. A run
-- writes, in the same UPDATE as the row's result, a fingerprint of the input
-- cells it read under its column's key: rows.run_inputs = {"<key id>": "<fp>"}.
-- A row whose inputs read differently now holds an out-of-date result. NULL
-- until a run writes one: such a row is never out of date. Kept on the row, so
-- a sort moves it, a delete takes it, and no read joins another table for it.
ALTER TABLE rows ADD COLUMN run_inputs TEXT;

-- A run column's key in rows.run_inputs: its name can change, its key can't
-- (a rename moves one record, not a million rows). AUTOINCREMENT never reuses
-- a key, so a column made later under a deleted one's name starts with none.
-- column_name is the run's main column (an AI run's column_name, an HTTP run's
-- master_column_name); rename, delete, a CSV replace and an undone import keep
-- it in step, as they do column descriptions.
CREATE TABLE run_input_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  column_name TEXT NOT NULL,
  UNIQUE(sheet_id, column_name)
);
CREATE INDEX idx_run_input_keys_user ON run_input_keys(user_id);

-- A deleted run column's key, until the column purge that strips its cells
-- (lib/column-purge.ts) has dropped it from every row's run_inputs too.
CREATE TABLE run_input_purges (
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  key INTEGER NOT NULL,
  PRIMARY KEY (sheet_id, key)
) WITHOUT ROWID;
