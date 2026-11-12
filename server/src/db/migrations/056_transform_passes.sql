-- transform_column's unfinished passes (services/column-transform-passes.ts). A
-- pass runs one transform into a column from the top of a sheet to its end,
-- over one call or several, each going on from the call before's next_cursor.
-- A sheet holds at most one unfinished pass per target column (the unique index
-- below). Its record is written in the same transaction as each page that
-- writes rows and when a call stops with rows left, so it holds the cursor the
-- pass last answered, and goes in the transaction of the page that ends the
-- pass. While it is there, whatever stopped the pass (a call's limit, an error,
-- a server that stopped during a call), a call that writes that column without
-- the pass's cursor is refused: starting over would apply an operation to
-- those rows twice. restart: true discards it. A cursor is taken only while it
-- is the one its record holds: the record's random pass_id is folded into the
-- cursor, so a cursor names one pass, and one whose pass is over is refused.
--
-- It follows its column (services/column-transform-pass-moves.ts): a rename
-- carries it along; the column sent to the trash takes it into the trash item
-- (trash_id, out of the column's name: a column added under that name meanwhile
-- has no pass), its restore brings it back under the name the column comes back
-- as, and a purge of the item drops it (the foreign key), as a delete for good
-- of the column does. A sheet or table in the trash keeps its records; deleted
-- for good, the foreign key drops them. A copy of the sheet's values gets
-- records of its own. Any change of the sheet's row_generation (a sort, a
-- replace, an import undone, duplicates removed) makes the cursors meaningless
-- and drops all the sheet's records, the trash's included (the trigger below),
-- as rows restored from the trash across a cursor drop that pass's.
CREATE TABLE transform_passes (
  pass_id TEXT PRIMARY KEY,              -- random, folded into the pass's cursors
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_column TEXT NOT NULL,           -- the column the pass writes, by name (in the trash: its name then)
  trash_id INTEGER REFERENCES trash_items(id) ON DELETE CASCADE, -- the trash item its column is in
  started_as TEXT NOT NULL,              -- its name when the pass started: the cursors' hash names it so
  call_key TEXT NOT NULL,                -- the hash of the call's arguments (target as started_as)
  cursor TEXT NOT NULL,                  -- the next_cursor the pass last answered
  rows_done INTEGER NOT NULL,            -- rows the pass has written, over all its calls
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_transform_passes_column ON transform_passes(sheet_id, user_id, target_column)
  WHERE trash_id IS NULL;
CREATE INDEX idx_transform_passes_sheet ON transform_passes(sheet_id);
CREATE INDEX idx_transform_passes_trash ON transform_passes(trash_id) WHERE trash_id IS NOT NULL;

-- Every place that moves row_generation (a sort, a replace, an import undone, a
-- duplicates removal), in the same statement.
CREATE TRIGGER transform_passes_row_generation AFTER UPDATE OF row_generation ON sheets
WHEN NEW.row_generation IS NOT OLD.row_generation
BEGIN
  DELETE FROM transform_passes WHERE sheet_id = NEW.id;
END;
