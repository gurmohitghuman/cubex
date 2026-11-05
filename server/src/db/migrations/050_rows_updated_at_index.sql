-- Rows changed since a time (read_rows and REST rows/query `updated_since`,
-- services/rows-since.ts and lib/row-since.ts): a sheet's rows in the order
-- their cells last changed. SQLite keeps each entry's rowid after its columns,
-- so this one index answers `sheet_id = ? AND (updated_at, rowid) > (?, ?)
-- ORDER BY updated_at, rowid` a page at a time, never scanning the sheet and
-- never sorting. (A separate `updated_at >= ?` beside the row value made
-- SQLite skip-scan it and sort, so the read has none.) Every write to
-- rows.data sets updated_at in the same statement (a sort, which only moves
-- row_index, doesn't), so a write moves its row's entry to the end.
CREATE INDEX idx_rows_sheet_updated ON rows(sheet_id, updated_at);
