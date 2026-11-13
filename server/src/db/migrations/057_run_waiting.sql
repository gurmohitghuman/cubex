-- What a run's rows wait for (lib/run-waiting.ts): a column another run holds,
-- as JSON {column, sheet_id (only when that column is on another sheet),
-- holder {type, id}, hold ('going' or 'clearing'), parked, rows (only for rows
-- that wait inside a waterfall's lookup step), since}. The run's own job writes
-- it when what it waits for changes, not on every look, and clears it once
-- nothing it reads is held. Readers show it only while the run is running or
-- pending (services/run-waiting-status.ts), so a run that ended, paused or was
-- stopped while it waited shows nothing. NULL: the run waits for nothing, or
-- it is from before this migration. Nullable, no backfill: nothing stored changes.
ALTER TABLE ai_runs ADD COLUMN waiting_on TEXT;
ALTER TABLE http_runs ADD COLUMN waiting_on TEXT;
