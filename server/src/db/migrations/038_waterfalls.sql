-- Waterfall columns (lib/waterfall/, services/waterfall-*.ts): an HTTP run
-- whose config carries a `waterfall` block fills one result per row by trying
-- ordered steps (treg tools, AI prompts, HTTP API calls) and stopping at the
-- first answer.

-- What a waterfall run's AI steps cost (OpenRouter's charge, and the user's
-- own provider key's), next to spent_micro (treg's charges, the ledger's).
-- REAL: one AI call can cost less than a micro-dollar.
ALTER TABLE http_runs ADD COLUMN ai_cost_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE http_runs ADD COLUMN ai_provider_cost_usd REAL NOT NULL DEFAULT 0;

-- Step answers kept for a replay at no cost (services/waterfall-journal.ts): a
-- row's finished AI and HTTP steps while the row still runs (scope: the run's
-- key scope, the run id or "a:<auto-run id>"; row_ref: the row's id), dropped
-- when the row is written; and a dry run's answers (scope 'dry', row_ref '':
-- matched by step_key alone), kept WATERFALL_ANSWER_KEEP_DAYS. step_key hashes
-- the step's settings and the input values it read (lib/waterfall/keys.ts).
CREATE TABLE waterfall_step_answers (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  row_ref TEXT NOT NULL,
  step_key TEXT NOT NULL,
  run_id TEXT NOT NULL,                     -- the run that paid for it
  outcome TEXT NOT NULL,                    -- JSON: what the step did
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL                  -- ISO time
);
CREATE INDEX idx_wf_answers_find ON waterfall_step_answers(user_id, scope, row_ref, step_key, created_at);
CREATE INDEX idx_wf_answers_age ON waterfall_step_answers(user_id, created_at);

-- Per run and step: the rows that reached it, that it answered, rejected,
-- failed or skipped (no inputs), and what it cost. Run status shows them; the
-- estimate reads a column's newest runs' answer rates for the same step_key
-- (the step's settings).
CREATE TABLE waterfall_step_tally (
  run_id TEXT NOT NULL REFERENCES http_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  reached INTEGER NOT NULL DEFAULT 0,
  answered INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, step_id)
) WITHOUT ROWID;

-- Usage history (migration 033) tells a waterfall run from a plain HTTP one by
-- its mode, and counts its AI steps' cost. The two triggers on http_runs are
-- made again with both; the others are unchanged.
ALTER TABLE run_usage ADD COLUMN mode TEXT;

DROP TRIGGER run_usage_http_insert;
CREATE TRIGGER run_usage_http_insert AFTER INSERT ON http_runs BEGIN
  INSERT OR REPLACE INTO run_usage (run_id, user_id, sheet_id, kind, mode, column_name, started_at, status, cells,
    enrich_micro, ai_cost_usd, provider_cost_usd)
  VALUES (NEW.id, NEW.user_id, NEW.sheet_id,
    CASE WHEN NOT json_valid(NEW.config) THEN 'http' WHEN json_type(NEW.config, '$.enrichment') IS NOT NULL
      THEN 'enrichment' ELSE 'http' END,
    CASE WHEN json_valid(NEW.config) AND json_type(NEW.config, '$.waterfall') = 'object' THEN 'waterfall' END,
    -- A dry run has no column of its own: the one it was started for.
    COALESCE(NEW.master_column_name,
      CASE WHEN json_valid(NEW.config) THEN json_extract(NEW.config, '$.waterfall.dry.column') END),
    NEW.created_at, NEW.status, NEW.processed_rows, NEW.spent_micro, NEW.ai_cost_usd, NEW.ai_provider_cost_usd);
END;

DROP TRIGGER run_usage_http_update;
CREATE TRIGGER run_usage_http_update AFTER UPDATE OF master_column_name, status, processed_rows, spent_micro,
  ai_cost_usd, ai_provider_cost_usd
ON http_runs BEGIN
  UPDATE run_usage SET
    column_name = COALESCE(NEW.master_column_name, column_name),
    column_deleted = CASE WHEN NEW.master_column_name IS NOT NULL THEN 0
      WHEN OLD.master_column_name IS NOT NULL THEN 1 ELSE column_deleted END,
    status = NEW.status, cells = NEW.processed_rows, enrich_micro = NEW.spent_micro,
    ai_cost_usd = CASE WHEN mode = 'waterfall' THEN NEW.ai_cost_usd ELSE ai_cost_usd END,
    provider_cost_usd = CASE WHEN mode = 'waterfall' THEN NEW.ai_provider_cost_usd ELSE provider_cost_usd END
  WHERE run_id = NEW.id;
END;
