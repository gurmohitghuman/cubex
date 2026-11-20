-- Rows a stopped run's ⏳ clear told the clean, formula and lookup columns reading its columns
-- (lib/placeholder-cells.ts, lib/derived-spans.ts): one span per slice of the clear that told rows, instead of
-- one autorun_pending row per told row and reader. So the clear's slices cost the same with 0 or 20 readers.
-- rowids: the told rows (rows.rowid), in storage order, as a JSON array. run_kind and run_id: the run whose
-- clear wrote it (NULL when a clear has no run); readers start on a span once that run's clear has ended.
-- No foreign key on the sheet: a sheet's purge and a CSV replace drop its spans in slices, with its queue.
CREATE TABLE derived_spans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sheet_id TEXT NOT NULL,
  run_kind TEXT CHECK (run_kind IN ('ai', 'http')),
  run_id TEXT,
  rowids TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_derived_spans_sheet ON derived_spans(sheet_id);

-- How far each reader (an autorun_columns entry of a follow kind) got through a span: `done` of its rowids are
-- worked out. A deleted reader drops its marks (the cascade); a reader turned off keeps them, as it keeps its
-- queued rows. A span goes with its last mark.
CREATE TABLE derived_span_marks (
  autorun_id TEXT NOT NULL REFERENCES autorun_columns(id) ON DELETE CASCADE,
  span_id INTEGER NOT NULL REFERENCES derived_spans(id) ON DELETE CASCADE,
  done INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (autorun_id, span_id)
);
CREATE INDEX idx_derived_span_marks_span ON derived_span_marks(span_id);

CREATE TRIGGER derived_span_last_mark AFTER DELETE ON derived_span_marks
WHEN NOT EXISTS (SELECT 1 FROM derived_span_marks WHERE span_id = OLD.span_id)
BEGIN
  DELETE FROM derived_spans WHERE id = OLD.span_id;
END;
