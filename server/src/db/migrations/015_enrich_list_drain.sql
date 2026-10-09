-- List results into rows (docs/enrichments.md). A run journals each source
-- row's results in enrichment_list_items (010) and the API process adds them
-- as rows in the destination sheet, one journal row per transaction.
--
-- Why a journal row waits instead of being added: 'fields' (the run was a test
-- and nobody has picked the fields to keep yet; they come from these results)
-- or 'room' (the destination sheet is full). NULL: it is being added. Only the
-- latter holds the destination against a sort, a CSV replace or a row delete.
ALTER TABLE enrichment_list_items ADD COLUMN wait_reason TEXT;
-- Failed attempts to add it; after a few it is marked failed and says why.
ALTER TABLE enrichment_list_items ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;

-- Rows a list run has added so far, for the drawer's progress (a counter, so a
-- poll never counts a million provenance rows).
ALTER TABLE http_runs ADD COLUMN list_rows_added INTEGER NOT NULL DEFAULT 0;
