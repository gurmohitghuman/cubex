-- Undo a run (lib/run-undo/, services/run-undo*.ts): before a run writes a
-- cell (its ⏳ at the start, a row's result, a list job's words), the cell's
-- value from before the run is kept here, once per run and row, with a print
-- of what the run last wrote there. "Undo this run" puts the old values back
-- in slices, skipping a cell whose print no longer matches (someone or
-- something changed it since). Nothing runs again and nothing is billed.
--
-- One journal per run that wrote a cell. The id is never reused
-- (AUTOINCREMENT): its rows belong to it, and a dropped journal's rows go in
-- slices. columns: the run's columns by slot (a row's cells name the slot),
-- so a rename rewrites one record, not a million rows; a deleted column's
-- slot reads null. stamp_path: the run's key in rows.run_inputs (migration
-- 039), whose old entry comes back with the row's cells.
-- state: kept (can be undone), undoing (cursor: the rows.rowid it got to; a
-- restart goes on), undone (its rows dropped; the counts stay), dropping (old
-- enough, its rows going for good).
CREATE TABLE run_undos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  sheet_id TEXT NOT NULL,                   -- no foreign keys: a sheet's purge drops its journals in slices
  run_kind TEXT NOT NULL CHECK (run_kind IN ('ai', 'http')),
  run_id TEXT NOT NULL,
  columns TEXT NOT NULL DEFAULT '[]',
  stamp_path TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'kept' CHECK (state IN ('kept', 'undoing', 'undone', 'dropping')),
  cursor INTEGER NOT NULL DEFAULT 0,
  restored INTEGER NOT NULL DEFAULT 0,      -- cells put back (or already holding their old value)
  skipped INTEGER NOT NULL DEFAULT 0,       -- cells changed since the run wrote them: left as they are
  gone INTEGER NOT NULL DEFAULT 0,          -- cells whose row or column was deleted since
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  undone_at TEXT,
  UNIQUE (run_kind, run_id)
);
CREATE INDEX idx_run_undos_sheet ON run_undos(sheet_id);
CREATE INDEX idx_run_undos_age ON run_undos(state, created_at);

-- A journal's rows: the row (rows.rowid, and ref, the first 8 characters of
-- rows.id: a rowid SQLite gives a new row after a delete is never taken for
-- the old one), its run_inputs entry before the run (JSON; NULL until read,
-- 'null' when it had none) and its cells: [[slot, old value, print], ...],
-- the old value as JSON (null: empty) and the print as lib/run-undo/print.ts
-- makes it. No user_id: every read goes through its journal.
CREATE TABLE run_undo_rows (
  undo_id INTEGER NOT NULL,
  row_id INTEGER NOT NULL,
  ref TEXT NOT NULL,
  stamp TEXT,
  cells TEXT NOT NULL,
  PRIMARY KEY (undo_id, row_id)
) WITHOUT ROWID;

-- A row an undo queued for a clean, formula or lookup column that reads a
-- restored cell (lib/autorun-mark.ts markDerivedInputs): once that column has
-- worked it out, only other such columns follow in turn, never an auto-run
-- that costs or sends requests, so an undo starts nothing paid. Any other
-- write queuing the same row makes it loud again (0).
ALTER TABLE autorun_pending ADD COLUMN quiet INTEGER NOT NULL DEFAULT 0;
