-- Enrichment runs (an http_runs row whose config carries an `enrichment`
-- block) stop themselves for reasons the user fixes in place: the run's spend
-- limit, today's limit, the treg balance, the key, an unreachable treg. The
-- reason's code says which fix to offer (raise the limit, top up, open
-- Settings); error_message holds its words. Both are cleared on resume.
ALTER TABLE http_runs ADD COLUMN pause_reason TEXT;

-- Rows a run left out at start because they lack its inputs ("212 rows
-- skipped: Website is empty"). They get no status, so a later run (or
-- auto-run) picks them up once the inputs are filled.
ALTER TABLE http_runs ADD COLUMN skipped_rows INTEGER;
