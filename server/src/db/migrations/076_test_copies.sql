-- Runs on a test copy (sheets.test_of, 070) count under the sheet it tests (services/usage.ts). What a run spent stays
-- in run_usage under the copy's id, and the copy is deleted when its test ends, so this keeps which sheet each copy
-- tested. Neither sheet's delete removes it: a copy's runs stay counted with the sheet's, deleted or not.
CREATE TABLE test_copies (
  copy_id TEXT PRIMARY KEY,
  sheet_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX idx_test_copies_sheet ON test_copies(sheet_id);

-- Every copy is made with test_of set (services/sheet-test-start.ts), so its link is made with it.
CREATE TRIGGER test_copies_insert AFTER INSERT ON sheets WHEN NEW.test_of IS NOT NULL BEGIN
  INSERT OR IGNORE INTO test_copies (copy_id, sheet_id, user_id) VALUES (NEW.id, NEW.test_of, NEW.user_id);
END;

-- Copies open when this runs.
INSERT OR IGNORE INTO test_copies (copy_id, sheet_id, user_id)
SELECT id, test_of, user_id FROM sheets WHERE test_of IS NOT NULL;
