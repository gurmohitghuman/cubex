-- Web search cost controls (lib/web-search-plan.ts). A run with web search
-- stores the engine it sends to OpenRouter, the engine that runs its searches
-- (what they're priced on), that engine's mode, and its cap on searches per
-- row. All NULL without web search; the engine is NULL on runs from before
-- this, which send none and get OpenRouter's default.
ALTER TABLE ai_runs ADD COLUMN web_search_engine TEXT
  CHECK (web_search_engine IN ('auto', 'native', 'exa', 'parallel', 'perplexity'));
ALTER TABLE ai_runs ADD COLUMN web_search_engine_used TEXT
  CHECK (web_search_engine_used IN ('native', 'exa', 'parallel', 'perplexity'));
ALTER TABLE ai_runs ADD COLUMN web_search_mode TEXT;
ALTER TABLE ai_runs ADD COLUMN web_search_max_per_row INTEGER CHECK (web_search_max_per_row >= 1);

-- What each row cost and searched: OpenRouter's usage.cost (tokens plus web
-- fees), the searches that ran, and every search call as JSON [{query, ran}].
-- NULL when OpenRouter didn't report it, or without web search.
ALTER TABLE ai_results ADD COLUMN cost_usd REAL;
ALTER TABLE ai_results ADD COLUMN web_searches INTEGER;
ALTER TABLE ai_results ADD COLUMN web_search_queries TEXT;

-- A run's outcome counts and its spend come from one index-only scan
-- (services/run-status.ts), read on every status poll. This covers 005's
-- (run_id, status), which goes.
CREATE INDEX idx_ai_results_run_outcome ON ai_results(run_id, status, cost_usd, web_searches);
DROP INDEX idx_ai_results_run_status;
