-- What the provider itself charged for a row served on the user's own key
-- through OpenRouter (BYOK): usage.cost_details.upstream_inference_cost when
-- usage.is_byok is true. cost_usd stays OpenRouter's own charge (its BYOK fee,
-- often $0). NULL on every other row. The outcome index takes it so a status
-- poll stays one index-only scan (services/ai-run-outcomes.ts).
ALTER TABLE ai_results ADD COLUMN provider_cost_usd REAL;
CREATE INDEX idx_ai_results_run_spend ON ai_results(run_id, status, cost_usd, web_searches, provider_cost_usd);
DROP INDEX idx_ai_results_run_outcome;
