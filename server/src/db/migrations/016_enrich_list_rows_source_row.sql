-- The rows one source row added to a destination, found by the source row's
-- id: a rerun of that row replaces them. They're matched to the column through
-- their runs (http_runs.master_column_name follows a column rename), so a
-- renamed status column never needs its provenance rewritten.
CREATE INDEX idx_enrichment_list_rows_source_row ON enrichment_list_rows(source_row_id, dest_sheet_id);
