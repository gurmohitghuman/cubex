-- What an AI run with a spend limit (migration 051) needs kept past its
-- worker, so a resume knows the least limit that lets it go on
-- (services/ai-run-limit.ts) and a new worker counts what the old one did
-- (services/ai-spend-gate.ts), in micro-USD:
--   spend_cut_off_micro: the most of each call cut off before its answer came
--     back (it may still be billed, with no cost Cubex saw), counted as spent
--     for the rest of the run, across resumes and restarts;
--   spend_next_row_micro: the most of the row it didn't start when it last
--     paused at its limit (pause_reason 'spend_limit'); NULL: none known (no
--     listed price, or it hasn't paused there).
ALTER TABLE ai_runs ADD COLUMN spend_cut_off_micro INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_runs ADD COLUMN spend_next_row_micro INTEGER;
