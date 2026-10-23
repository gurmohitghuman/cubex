-- Copying a sheet's values to a new sheet (services/sheet-copy*.ts) adds the
-- rows in slices, so a restart can stop it halfway. The copy is journaled in
-- the transaction that creates the new sheet, its cursor moves in each
-- slice's transaction, and boot goes on from the cursor. Empty when Cubex is
-- idle.
CREATE TABLE sheet_copy_jobs (
  -- The new sheet; the job goes with it.
  sheet_id        TEXT PRIMARY KEY REFERENCES sheets(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The sheet copied. No foreign key: a source deleted for good from the trash
  -- meanwhile leaves no rows to read, and the copy ends with what it has.
  source_sheet_id TEXT NOT NULL,
  columns         TEXT NOT NULL,          -- JSON array: the source columns copied, in order
  -- The rows copied are the source's rows at the start: at row_index <= end_row
  -- and rowid <= max_rowid (a row added since has a higher rowid), at most
  -- row_count of them, the new sheet's reserved range.
  end_row         INTEGER NOT NULL,
  max_rowid       INTEGER NOT NULL,
  row_count       INTEGER NOT NULL,
  after_row       INTEGER,                -- the last source row_index copied (NULL: none yet)
  copied          INTEGER NOT NULL DEFAULT 0, -- rows copied so far: the new sheet's next row_index
  change_id       INTEGER                 -- the copy's History line, said again with what it copied
);
