-- Usage history (services/usage.ts): one small record per AI, HTTP or
-- enrichment run, kept in step with the run tables by triggers on every
-- connection (workers too; built-in SQL only, trusted_schema=OFF), so the
-- Usage view sums runs without reading a run's config, prompt or results.
--   cells: the rows the run ran (processed_rows); reused_cells: of those, filled
--   from an earlier found answer at no cost (enrich_run_reuse); ai_cost_usd:
--   what OpenRouter charged (web fees included); provider_cost_usd: what the
--   user's own provider key was billed; enrich_micro: treg's charges (the
--   ledger's sum).
-- The column follows renames; a deleted column keeps its last name with
-- column_deleted = 1 (AI runs keep a " deleted:<name>" tombstone, HTTP runs a
-- NULL). The record stays when its run goes with a deleted sheet: what was
-- spent was spent (the enrichment ledger keeps its calls the same way).
CREATE TABLE run_usage (
  run_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  sheet_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ai', 'enrichment', 'http')),
  column_name TEXT,
  column_deleted INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  status TEXT NOT NULL,
  cells INTEGER NOT NULL DEFAULT 0,
  reused_cells INTEGER NOT NULL DEFAULT 0,
  ai_cost_usd REAL NOT NULL DEFAULT 0,
  provider_cost_usd REAL NOT NULL DEFAULT 0,
  enrich_micro INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

-- Existing runs: their AI cost as their results still hold it (rows deleted
-- before this took their results with them), enrichment spend from the run's
-- ledger counter, and a deleted enrichment column's name from its ledger.
INSERT INTO run_usage (run_id, user_id, sheet_id, kind, column_name, column_deleted, started_at, status, cells)
SELECT id, user_id, sheet_id, 'ai',
  CASE WHEN substr(column_name, 1, 9) = ' deleted:' THEN substr(column_name, 10) ELSE column_name END,
  substr(column_name, 1, 9) = ' deleted:', created_at, status, processed_rows
FROM ai_runs;
UPDATE run_usage SET (ai_cost_usd, provider_cost_usd) = (
  SELECT IFNULL(SUM(cost_usd), 0), IFNULL(SUM(provider_cost_usd), 0) FROM ai_results WHERE run_id = run_usage.run_id
) WHERE kind = 'ai';
INSERT INTO run_usage (run_id, user_id, sheet_id, kind, column_name, column_deleted, started_at, status, cells,
  enrich_micro)
SELECT id, user_id, sheet_id,
  CASE WHEN NOT json_valid(config) THEN 'http' WHEN json_type(config, '$.enrichment') IS NOT NULL THEN 'enrichment'
    ELSE 'http' END,
  COALESCE(master_column_name, (SELECT c.status_column FROM enrichment_calls c WHERE c.run_id = http_runs.id
    AND c.status_column IS NOT NULL LIMIT 1)),
  master_column_name IS NULL, created_at, status, processed_rows, spent_micro
FROM http_runs;

UPDATE run_usage SET reused_cells = (SELECT reused_rows FROM enrich_run_reuse WHERE run_id = run_usage.run_id)
WHERE run_id IN (SELECT run_id FROM enrich_run_reuse);

CREATE INDEX idx_run_usage_sheet_time ON run_usage(sheet_id, started_at);
CREATE INDEX idx_run_usage_user_time ON run_usage(user_id, started_at);

CREATE TRIGGER run_usage_ai_insert AFTER INSERT ON ai_runs BEGIN
  INSERT OR REPLACE INTO run_usage (run_id, user_id, sheet_id, kind, column_name, column_deleted, started_at,
    status, cells)
  VALUES (NEW.id, NEW.user_id, NEW.sheet_id, 'ai',
    CASE WHEN substr(NEW.column_name, 1, 9) = ' deleted:' THEN substr(NEW.column_name, 10) ELSE NEW.column_name END,
    substr(NEW.column_name, 1, 9) = ' deleted:', NEW.created_at, NEW.status, NEW.processed_rows);
END;

CREATE TRIGGER run_usage_ai_update AFTER UPDATE OF column_name, status, processed_rows ON ai_runs BEGIN
  UPDATE run_usage SET
    column_name = CASE WHEN substr(NEW.column_name, 1, 9) = ' deleted:' THEN substr(NEW.column_name, 10)
      ELSE NEW.column_name END,
    column_deleted = substr(NEW.column_name, 1, 9) = ' deleted:',
    status = NEW.status, cells = NEW.processed_rows
  WHERE run_id = NEW.id;
END;

-- Every billed call: a failed row's call that came back was billed too.
CREATE TRIGGER run_usage_ai_cost AFTER INSERT ON ai_results
WHEN NEW.cost_usd IS NOT NULL OR NEW.provider_cost_usd IS NOT NULL BEGIN
  UPDATE run_usage SET ai_cost_usd = ai_cost_usd + IFNULL(NEW.cost_usd, 0),
    provider_cost_usd = provider_cost_usd + IFNULL(NEW.provider_cost_usd, 0)
  WHERE run_id = NEW.run_id;
END;

CREATE TRIGGER run_usage_http_insert AFTER INSERT ON http_runs BEGIN
  INSERT OR REPLACE INTO run_usage (run_id, user_id, sheet_id, kind, column_name, started_at, status, cells,
    enrich_micro)
  VALUES (NEW.id, NEW.user_id, NEW.sheet_id,
    CASE WHEN NOT json_valid(NEW.config) THEN 'http' WHEN json_type(NEW.config, '$.enrichment') IS NOT NULL
      THEN 'enrichment' ELSE 'http' END,
    NEW.master_column_name, NEW.created_at, NEW.status, NEW.processed_rows, NEW.spent_micro);
END;

-- A column delete sets master_column_name NULL: the name stays, marked deleted.
CREATE TRIGGER run_usage_http_update AFTER UPDATE OF master_column_name, status, processed_rows, spent_micro
ON http_runs BEGIN
  UPDATE run_usage SET
    column_name = COALESCE(NEW.master_column_name, column_name),
    column_deleted = CASE WHEN NEW.master_column_name IS NOT NULL THEN 0
      WHEN OLD.master_column_name IS NOT NULL THEN 1 ELSE column_deleted END,
    status = NEW.status, cells = NEW.processed_rows, enrich_micro = NEW.spent_micro
  WHERE run_id = NEW.id;
END;

CREATE TRIGGER run_usage_reused_insert AFTER INSERT ON enrich_run_reuse BEGIN
  UPDATE run_usage SET reused_cells = NEW.reused_rows WHERE run_id = NEW.run_id;
END;

CREATE TRIGGER run_usage_reused_update AFTER UPDATE OF reused_rows ON enrich_run_reuse BEGIN
  UPDATE run_usage SET reused_cells = NEW.reused_rows WHERE run_id = NEW.run_id;
END;
