-- Auto-run for enrichment and HTTP API columns (services/autorun-*.ts): a run
-- it starts names its entry and the UTC day it started, so an entry's daily
-- cap reads today's runs through one index (spent_micro for an enrichment's
-- dollars, total_rows for an HTTP column's rows), never the ledger.
ALTER TABLE http_runs ADD COLUMN autorun_id TEXT;
ALTER TABLE http_runs ADD COLUMN autorun_day TEXT;
CREATE INDEX idx_http_runs_autorun ON http_runs(autorun_id, autorun_day) WHERE autorun_id IS NOT NULL;
-- A column's runs (is one active, which is newest): auto-run adds many.
CREATE INDEX idx_http_runs_sheet_column ON http_runs(sheet_id, master_column_name);

-- Why an auto-run is paused, in words (paused_reason keeps the code the UI
-- offers a fix for), and since when: some stops are retried a few minutes on.
ALTER TABLE autorun_columns ADD COLUMN paused_message TEXT;
ALTER TABLE autorun_columns ADD COLUMN paused_at TEXT;
