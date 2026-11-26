-- Trying column changes on sample rows (services/sheet-test*.ts): a hidden copy of a sheet holding some of its rows
-- and its setup, changed and run there; then applied to the sheet or discarded. While a test is open the sheet is
-- read-only (lib/sheet-busy.ts) and its webhook deliveries wait, kept, to be added when the test ends.

-- The copy is a sheet of the same table that no list shows (tabs, list_tables, row counts, pickers): test_of names
-- the sheet it tests. Its name is the sheet's own, so the name index leaves copies out.
ALTER TABLE sheets ADD COLUMN test_of TEXT;
DROP INDEX idx_sheets_table_name_ci;
CREATE UNIQUE INDEX idx_sheets_table_name_ci ON sheets(table_id, LOWER(name))
  WHERE trash_id IS NULL AND test_of IS NULL;
CREATE INDEX idx_sheets_test_of ON sheets(test_of) WHERE test_of IS NOT NULL;

-- One test per sheet. 'open': the sheet is read-only; 'ending': applied or discarded, the copy is being deleted and
-- the kept deliveries added (boot finishes it). The record is the journal: boot holds an open test's sheet again.
CREATE TABLE sheet_tests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sheet_id TEXT NOT NULL UNIQUE REFERENCES sheets(id) ON DELETE CASCADE,
  test_sheet_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'ending')),
  outcome TEXT CHECK (outcome IN ('applied', 'discarded')),
  started_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sheet_tests_user ON sheet_tests(user_id);

-- Which row of the sheet each copied row is (rows.id on both sides), so applying puts results back on the right row.
CREATE TABLE sheet_test_rows (
  test_id TEXT NOT NULL REFERENCES sheet_tests(id) ON DELETE CASCADE,
  test_row_id TEXT NOT NULL,
  live_row_id TEXT NOT NULL,
  PRIMARY KEY (test_id, test_row_id)
) WITHOUT ROWID;
CREATE UNIQUE INDEX idx_sheet_test_rows_live ON sheet_test_rows(test_id, live_row_id);

-- A delivery that came while its sheet was being tested: status 'held', its payload kept (the prune leaves it), added
-- in arrival order once the test ends.
CREATE INDEX idx_webhook_deliveries_held ON webhook_deliveries(sheet_id) WHERE status = 'held';
