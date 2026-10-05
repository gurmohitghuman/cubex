-- The "(Data)" citations column of a structured (multi-column) AI run that
-- uses web search or web fetch. Stored, not derived from the status column's
-- name, so renaming either column can't break the link (rename/delete update
-- it the way they update status_column). NULL for single-column runs, whose
-- "(Data)" column is still derived from the "(Output)" name.
ALTER TABLE ai_runs ADD COLUMN data_column TEXT;
