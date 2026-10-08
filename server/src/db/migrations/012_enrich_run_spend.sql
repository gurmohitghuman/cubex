-- What an enrichment run has spent, kept in step with the ledger: each
-- enrichment_calls insert adds its cost here in the same transaction
-- (services/enrich-ledger.ts), so the per-batch limit check and status reads
-- are one row read, not a SUM over every call the run made.
ALTER TABLE http_runs ADD COLUMN spent_micro INTEGER NOT NULL DEFAULT 0;

-- A rerun first looks for a paid answer an earlier run of the same row lost
-- (cancelled in flight) before buying it again (services/enrich-recover.ts).
CREATE INDEX idx_enrichment_calls_row_tool ON enrichment_calls(row_id, tool_id);
