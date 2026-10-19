-- Spend cap per access token (services/token-spend.ts). A token can carry a
-- lifetime cap on what its runs spend (AI + enrichments, in micro-USD; NULL:
-- no cap), counted from the usage history's own numbers (run_usage).
--
-- Who a run is done for: the token that started it, the token that turned an
-- auto-run on, the token that applied a setup (NULL: the app, or Cubex on its
-- own). The run's usage record copies it, and so does a preview's or an AI
-- helper's (their own run_usage records, mode 'preview' / 'assist').
ALTER TABLE access_tokens ADD COLUMN spend_cap_micro INTEGER;
ALTER TABLE ai_runs ADD COLUMN access_token_id TEXT;
ALTER TABLE http_runs ADD COLUMN access_token_id TEXT;
ALTER TABLE autorun_columns ADD COLUMN access_token_id TEXT;
ALTER TABLE setup_runs ADD COLUMN access_token_id TEXT;
ALTER TABLE run_usage ADD COLUMN access_token_id TEXT;
CREATE INDEX idx_run_usage_token ON run_usage(access_token_id, started_at) WHERE access_token_id IS NOT NULL;

-- Why an AI run paused itself ('token_cap'); NULL when a person paused it.
ALTER TABLE ai_runs ADD COLUMN pause_reason TEXT;

-- A waterfall run's rows hold their AI part too (services/enrich-holds.ts), so
-- the runs of one token can't each count the same room under its cap. Only the
-- token's room reads it: today's enrichment limit is treg's part alone.
ALTER TABLE enrich_holds ADD COLUMN ai_hold_micro INTEGER NOT NULL DEFAULT 0;

-- A fast copy of each token's run_usage sums, kept by the triggers below in
-- the transaction that changes run_usage (on every connection, workers too),
-- so the check before each call reads one row. It only ever goes up: a run,
-- row, column or sheet deleted, the trash purged or a run undone never gives
-- spend back (and run_usage records are never deleted).
CREATE TABLE token_spend (
  access_token_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  ai_cost_usd REAL NOT NULL DEFAULT 0,
  provider_cost_usd REAL NOT NULL DEFAULT 0,
  enrich_micro INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

-- The two insert triggers of migrations 033 and 038, made again with the token.
DROP TRIGGER run_usage_ai_insert;
CREATE TRIGGER run_usage_ai_insert AFTER INSERT ON ai_runs BEGIN
  INSERT OR REPLACE INTO run_usage (run_id, user_id, sheet_id, kind, column_name, column_deleted, started_at,
    status, cells, access_token_id)
  VALUES (NEW.id, NEW.user_id, NEW.sheet_id, 'ai',
    CASE WHEN substr(NEW.column_name, 1, 9) = ' deleted:' THEN substr(NEW.column_name, 10) ELSE NEW.column_name END,
    substr(NEW.column_name, 1, 9) = ' deleted:', NEW.created_at, NEW.status, NEW.processed_rows,
    NEW.access_token_id);
END;

DROP TRIGGER run_usage_http_insert;
CREATE TRIGGER run_usage_http_insert AFTER INSERT ON http_runs BEGIN
  INSERT OR REPLACE INTO run_usage (run_id, user_id, sheet_id, kind, mode, column_name, started_at, status, cells,
    enrich_micro, ai_cost_usd, provider_cost_usd, access_token_id)
  VALUES (NEW.id, NEW.user_id, NEW.sheet_id,
    CASE WHEN NOT json_valid(NEW.config) THEN 'http' WHEN json_type(NEW.config, '$.enrichment') IS NOT NULL
      THEN 'enrichment' ELSE 'http' END,
    CASE WHEN json_valid(NEW.config) AND json_type(NEW.config, '$.waterfall') = 'object' THEN 'waterfall' END,
    -- A dry run has no column of its own: the one it was started for.
    COALESCE(NEW.master_column_name,
      CASE WHEN json_valid(NEW.config) THEN json_extract(NEW.config, '$.waterfall.dry.column') END),
    NEW.created_at, NEW.status, NEW.processed_rows, NEW.spent_micro, NEW.ai_cost_usd, NEW.ai_provider_cost_usd,
    NEW.access_token_id);
END;

CREATE TRIGGER token_spend_insert AFTER INSERT ON run_usage WHEN NEW.access_token_id IS NOT NULL BEGIN
  INSERT INTO token_spend (access_token_id, user_id, ai_cost_usd, provider_cost_usd, enrich_micro)
  VALUES (NEW.access_token_id, NEW.user_id, MAX(NEW.ai_cost_usd, 0), MAX(NEW.provider_cost_usd, 0),
    MAX(NEW.enrich_micro, 0))
  ON CONFLICT (access_token_id) DO UPDATE SET
    ai_cost_usd = ai_cost_usd + excluded.ai_cost_usd,
    provider_cost_usd = provider_cost_usd + excluded.provider_cost_usd,
    enrich_micro = enrich_micro + excluded.enrich_micro;
END;

-- Only what went up is added (a figure that went down gives nothing back).
CREATE TRIGGER token_spend_update AFTER UPDATE OF ai_cost_usd, provider_cost_usd, enrich_micro ON run_usage
WHEN NEW.access_token_id IS NOT NULL AND (NEW.ai_cost_usd > OLD.ai_cost_usd
  OR NEW.provider_cost_usd > OLD.provider_cost_usd OR NEW.enrich_micro > OLD.enrich_micro) BEGIN
  INSERT INTO token_spend (access_token_id, user_id, ai_cost_usd, provider_cost_usd, enrich_micro)
  VALUES (NEW.access_token_id, NEW.user_id, MAX(NEW.ai_cost_usd - OLD.ai_cost_usd, 0),
    MAX(NEW.provider_cost_usd - OLD.provider_cost_usd, 0), MAX(NEW.enrich_micro - OLD.enrich_micro, 0))
  ON CONFLICT (access_token_id) DO UPDATE SET
    ai_cost_usd = ai_cost_usd + excluded.ai_cost_usd,
    provider_cost_usd = provider_cost_usd + excluded.provider_cost_usd,
    enrich_micro = enrich_micro + excluded.enrich_micro;
END;
