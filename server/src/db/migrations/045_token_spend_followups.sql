-- Spend cap per access token (migration 042), two follow-ups.
--
-- 1. An AI call that came back (and was billed) for a row a pause, cancel or
-- resume then dropped: its row writes nothing (no ai_results record, whose
-- trigger adds a row's cost to the run's usage record), so what it cost was
-- lost and a pause/resume loop could spend past a token's cap. The row writer
-- now records such a call here (services/ai-row-writers.ts recordDroppedCall),
-- and the trigger adds its cost to the run's usage record, so the usage
-- history, the run's own cost and the run's token (token_spend, migration 042)
-- count it. A row is never read back as a result; it goes with its run.
CREATE TABLE ai_dropped_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ai_runs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cost_usd REAL,
  provider_cost_usd REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- A run's cost (services/ai-run-outcomes.ts) sums its rows here from the index alone.
CREATE INDEX idx_ai_dropped_calls_run ON ai_dropped_calls(run_id, user_id, cost_usd, provider_cost_usd);

CREATE TRIGGER run_usage_ai_dropped_cost AFTER INSERT ON ai_dropped_calls
WHEN NEW.cost_usd IS NOT NULL OR NEW.provider_cost_usd IS NOT NULL BEGIN
  UPDATE run_usage SET ai_cost_usd = ai_cost_usd + IFNULL(NEW.cost_usd, 0),
    provider_cost_usd = provider_cost_usd + IFNULL(NEW.provider_cost_usd, 0)
  WHERE run_id = NEW.run_id;
END;

-- 2. A run an access token resumes becomes that token's (services/run-lifecycle.ts),
-- so what it spends from then on counts against the token that resumed it. The
-- usage record follows the run's token: the two update triggers (033's AI one,
-- 038's HTTP one) are made again with access_token_id, otherwise unchanged.
-- token_spend only ever adds what went up to the record's token at that time,
-- so the old token keeps what was billed while the run was its own and the new
-- one gets the rest, calls already out when the run changed hands included
-- (they count for the token that resumed it). The app resuming a revoked
-- token's run takes it over (NULL: no token).
DROP TRIGGER run_usage_ai_update;
CREATE TRIGGER run_usage_ai_update AFTER UPDATE OF column_name, status, processed_rows, access_token_id
ON ai_runs BEGIN
  UPDATE run_usage SET
    column_name = CASE WHEN substr(NEW.column_name, 1, 9) = ' deleted:' THEN substr(NEW.column_name, 10)
      ELSE NEW.column_name END,
    column_deleted = substr(NEW.column_name, 1, 9) = ' deleted:',
    status = NEW.status, cells = NEW.processed_rows, access_token_id = NEW.access_token_id
  WHERE run_id = NEW.id;
END;

DROP TRIGGER run_usage_http_update;
CREATE TRIGGER run_usage_http_update AFTER UPDATE OF master_column_name, status, processed_rows, spent_micro,
  ai_cost_usd, ai_provider_cost_usd, access_token_id
ON http_runs BEGIN
  UPDATE run_usage SET
    column_name = COALESCE(NEW.master_column_name, column_name),
    column_deleted = CASE WHEN NEW.master_column_name IS NOT NULL THEN 0
      WHEN OLD.master_column_name IS NOT NULL THEN 1 ELSE column_deleted END,
    status = NEW.status, cells = NEW.processed_rows, enrich_micro = NEW.spent_micro,
    ai_cost_usd = CASE WHEN mode = 'waterfall' THEN NEW.ai_cost_usd ELSE ai_cost_usd END,
    provider_cost_usd = CASE WHEN mode = 'waterfall' THEN NEW.ai_provider_cost_usd ELSE provider_cost_usd END,
    access_token_id = NEW.access_token_id
  WHERE run_id = NEW.id;
END;
