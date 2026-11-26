-- Rows picked from a trash batch (seqs, a JSON array) while they go back: they go in slices sized by bytes
-- (services/trash-restore.ts, lib/trash/restore-rows.ts), so a restart that cut them short finishes those picks,
-- not the whole batch. NULL when the whole batch goes back, and once it is kept again.
ALTER TABLE trash_items ADD COLUMN restore_picks TEXT;
