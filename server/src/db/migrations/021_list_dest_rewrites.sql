-- Renaming or deleting a column also rewrites the list jobs that add rows into
-- its sheet from another one: the fields they keep and the columns they copy
-- into name it. Auto-run leaves a run per batch, so thousands of runs can add
-- rows into one sheet. Like the sheet's own runs (018), they are rewritten a
-- page per transaction after the switch, newest first, with the sheet still
-- busy (services/run-config-rewrite.ts), and a restart finishes them. Where
-- that pass got to (the runs into the sheet below this rowid are still to do);
-- 0: done. Rewrites recorded before this did that pass in the switch itself.
ALTER TABLE run_config_rewrites ADD COLUMN dest_before_rowid INTEGER NOT NULL DEFAULT 0;
