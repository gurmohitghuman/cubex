-- Run status reports how many rows failed and succeeded (services/run-status.ts),
-- read on every poll. With only (run_id) indexed, counting by status read every
-- result row of the run: fine at 100 rows, not at a million. (run_id, status)
-- makes the count an index-only lookup. The old single-column indexes are a
-- prefix of these, so they go.
CREATE INDEX idx_ai_results_run_status ON ai_results(run_id, status);
DROP INDEX idx_ai_results_run;
CREATE INDEX idx_http_results_run_status ON http_results(run_id, status);
DROP INDEX idx_http_results_run;
