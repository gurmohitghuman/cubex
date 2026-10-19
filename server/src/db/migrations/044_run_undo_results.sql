-- An undone run's results (migration 041, lib/run-undo/restore.ts): a row
-- whose main cell the undo put back no longer holds this run's answer, so its
-- result is marked undone in the undo slice's transaction. The cell's answer
-- and sources (services/answer-runs.ts, routes/ai-read.ts) and a column added
-- from stored answers (services/answer-field-fill.ts) pass it over for the run
-- before. Its reuse_key is cleared there too, so running the column again
-- calls (and bills) again instead of reusing it (services/enrich-reuse.ts). A
-- row the undo skipped (its cell changed since) keeps its result as it was.
-- The run's own results, cost and usage still list the row.
ALTER TABLE http_results ADD COLUMN undone INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_results ADD COLUMN undone INTEGER NOT NULL DEFAULT 0;
