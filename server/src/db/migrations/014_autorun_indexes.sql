-- Auto-run starts a run whenever a sweep finds rows, so a column can gather
-- thousands of runs. What it reads every sweep gets its own index:
-- a column's newest run (what auto-run repeats) without sorting all of them,
DROP INDEX IF EXISTS idx_http_runs_sheet_column;
CREATE INDEX idx_http_runs_sheet_column_time ON http_runs(sheet_id, master_column_name, created_at);
-- whether a run on the column is active or still clearing its cells (few at
-- any time; a query must repeat this WHERE word for word to use it),
CREATE INDEX idx_http_runs_active ON http_runs(sheet_id, master_column_name)
  WHERE status IN ('pending', 'running', 'paused') OR placeholder_work IS NOT NULL;
-- and a column's output columns, by column and by run.
CREATE INDEX idx_http_assoc_sheet_master ON http_column_associations(sheet_id, master_column_name);
CREATE INDEX idx_http_assoc_run ON http_column_associations(run_id);
