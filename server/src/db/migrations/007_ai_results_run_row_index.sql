-- One run's results by row: the sources behind a "(Data)" cell (routes/ai-read.ts,
-- looked up per click) and run results paged by row_index (services/run-status.ts).
-- (run_id, status) from 005 can't seek on a row, so both read the run's whole
-- result set: a million rows for a million-row run.
CREATE INDEX idx_ai_results_run_row ON ai_results(run_id, row_index);
