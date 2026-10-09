-- List results into rows: what the drain, the guards, the tab dot and the
-- drawer's progress read, without walking the stored results. A journal row
-- holds up to 100 raw results (items_json, possibly large), so its result
-- count is kept beside it and every read of the journal's state goes through
-- a covering index.
ALTER TABLE enrichment_list_items ADD COLUMN item_count INTEGER NOT NULL DEFAULT 0;
UPDATE enrichment_list_items SET item_count = IFNULL(json_array_length(items_json, '$.items'), 0)
  WHERE json_valid(items_json);

-- By destination: the drain's per-sheet pick, rows being added there (sort,
-- delete and CSV replace guards, the tab dot), results waiting for room.
CREATE INDEX idx_eli_dest_state
  ON enrichment_list_items(dest_sheet_id, status, wait_reason, created_at, item_count, user_id);
-- By run: the drawer's progress, results released when fields are picked.
CREATE INDEX idx_eli_run_state ON enrichment_list_items(run_id, status, wait_reason, item_count, user_id);
-- By source sheet and row: a column's rows being added or waiting for fields
-- (how many, the oldest first), and whether a newer journal row of the same
-- source row is still pending.
CREATE INDEX idx_eli_source_state
  ON enrichment_list_items(source_sheet_id, status, wait_reason, run_id, user_id, created_at, item_count);
CREATE INDEX idx_eli_source_row ON enrichment_list_items(source_row_id, status);
-- Which destinations have rows to add, and which runs' results wait for
-- fields (the drain's first reads).
CREATE INDEX idx_eli_pending ON enrichment_list_items(status, wait_reason, dest_sheet_id, run_id)
  WHERE status = 'pending';

-- Superseded by the indexes above (their leading columns still serve the
-- sheet and run cascades), and by 016 for a source row's earlier rows.
DROP INDEX idx_enrichment_list_items_pending;
DROP INDEX idx_enrichment_list_items_run;
DROP INDEX idx_enrichment_list_items_source;
DROP INDEX idx_enrichment_list_items_dest;
DROP INDEX idx_enrichment_list_rows_source;
