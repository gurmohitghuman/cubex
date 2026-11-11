-- transform_column's passes (services/column-transform-passes.ts). A pass runs
-- the same transform from the top of a sheet to its end, over one call or
-- several, each going on from the call before's next_cursor. Its record is
-- written in the same transaction as each page that writes rows, and goes in
-- the transaction of the page that ends the pass. A call stopped at its limit
-- sets open to 0. One stopped on an error, or a server that stopped during a
-- call, leaves open at 1 with the cursor after the last page that wrote rows,
-- and the same call without cursor is refused: starting over would apply the
-- operation to those rows twice. It goes with its sheet.
CREATE TABLE transform_passes (
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  call_key TEXT NOT NULL,                -- sha256 of the call's arguments
  cursor TEXT NOT NULL,                  -- the next_cursor after the last page that wrote rows
  rows_done INTEGER NOT NULL,            -- rows the pass has written, over all its calls
  open INTEGER NOT NULL CHECK (open IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (sheet_id, user_id, call_key)
);
