-- transform_column's unfinished passes (services/column-transform-passes.ts). A
-- pass runs one transform into a column from the top of a sheet to its end,
-- over one call or several, each going on from the call before's next_cursor.
-- A sheet holds at most one unfinished pass per target column. Its record is
-- written in the same transaction as each page that writes rows, and goes in
-- the transaction of the page that ends the pass. While it is there, whatever
-- stopped the pass (a call's limit, an error, a server that stopped during a
-- call), a call that writes that column without the pass's cursor is refused:
-- starting over would apply an operation to those rows twice. restart: true
-- discards it. It also goes with its column (services/column-delete.ts; a
-- rename carries it along, services/column-rename.ts), with its sheet (the
-- trash, services/trash-sheets.ts; for good, the foreign key), and with any
-- change of the sheet's row_generation (a sort, a replace), which makes its
-- cursor meaningless (the trigger below).
CREATE TABLE transform_passes (
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_column TEXT NOT NULL,           -- the column the pass writes, by name
  started_as TEXT NOT NULL,              -- its name when the pass started: the cursors' hash names it so
  cursor TEXT NOT NULL,                  -- the next_cursor after the last page that wrote rows
  rows_done INTEGER NOT NULL,            -- rows the pass has written, over all its calls
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (sheet_id, user_id, target_column)
);

-- Every place that moves row_generation (a sort, a replace, an import undone, a
-- duplicates removal), in the same statement.
CREATE TRIGGER transform_passes_row_generation AFTER UPDATE OF row_generation ON sheets
WHEN NEW.row_generation IS NOT OLD.row_generation
BEGIN
  DELETE FROM transform_passes WHERE sheet_id = NEW.id;
END;
