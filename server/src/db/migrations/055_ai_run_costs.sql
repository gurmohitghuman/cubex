-- Who paid for each AI row, and its reasoning tokens (services/ai-row-writers.ts,
-- from the call's usage: lib/responses-adapter.ts). paid_with: 'own_key' when
-- OpenRouter says the call ran on the user's own provider key (usage.is_byok
-- true), 'credits' when it says OpenRouter's credits paid (false; a row whose
-- own key failed and fell back to shared capacity says so too). NULL: a row
-- from before this migration, or a call that didn't say. Calls a pause or
-- cancel dropped (ai_dropped_calls) keep what they stored before.
ALTER TABLE ai_results ADD COLUMN reasoning_tokens INTEGER;
ALTER TABLE ai_results ADD COLUMN paid_with TEXT CHECK (paid_with IN ('own_key', 'credits'));

-- A run's summary counts rows per payer in the same index-only scan that sums
-- its cost (services/ai-run-outcomes.ts), so the outcome index takes paid_with.
CREATE INDEX idx_ai_results_run_payer
  ON ai_results(run_id, status, cost_usd, web_searches, provider_cost_usd, paid_with);
DROP INDEX idx_ai_results_run_spend;

-- estimate_only's token history (services/ai-token-history.ts) prefers this
-- column's own runs of the prompt, then runs of the same prompt, then the
-- model's runs. Each is read newest first through its own index, never a sort
-- over every run. prompt_hash: sha256 of the prompt text with its system
-- prompt and output column count (lib/ai-prompt-hash.ts), set by every start
-- and rerun and kept by a column rename that rewrites the prompt; NULL on
-- older runs (they still count for their column and model).
ALTER TABLE ai_runs ADD COLUMN prompt_hash TEXT;
CREATE INDEX idx_ai_runs_column_history ON ai_runs(sheet_id, column_name, model, created_at);
CREATE INDEX idx_ai_runs_prompt_history ON ai_runs(user_id, model, prompt_hash, created_at);
CREATE INDEX idx_ai_runs_model_history ON ai_runs(user_id, model, created_at);

-- What previews measured (run_ai_column's preview_rows and the app's preview),
-- so an estimate of the same prompt on the same model can use it before any
-- run has finished. One ai_previews row a preview: its prompt (a column
-- rename rewrites it and its hash, as it does a run's), its system prompt,
-- how many output columns it filled, and its web tools and fetch limits (NULL:
-- no limit), which an estimate matches like a run's. Its rows' token counts
-- are in ai_preview_tokens, rows without an error only. A new preview of the
-- same prompt and model on a sheet replaces the earlier one there, each user
-- keeps at most the newest AI_PREVIEW_HISTORY_MAX_ROWS rows (a preview left
-- with none goes too), and they go with their sheet.
CREATE TABLE ai_previews (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  system_prompt TEXT,
  output_count INTEGER NOT NULL DEFAULT 0,
  prompt_hash TEXT NOT NULL,
  web_search INTEGER NOT NULL DEFAULT 0,
  web_fetch INTEGER NOT NULL DEFAULT 0,
  web_search_engine_used TEXT,
  web_fetch_max_content_tokens INTEGER,
  web_fetch_max_pages INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ai_previews_prompt ON ai_previews(user_id, model, prompt_hash);
CREATE INDEX idx_ai_previews_sheet ON ai_previews(sheet_id, user_id);
CREATE TABLE ai_preview_tokens (
  id INTEGER PRIMARY KEY,
  preview_id INTEGER NOT NULL REFERENCES ai_previews(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  reasoning_tokens INTEGER
);
CREATE INDEX idx_ai_preview_tokens_preview ON ai_preview_tokens(preview_id);
CREATE INDEX idx_ai_preview_tokens_user ON ai_preview_tokens(user_id);

-- Web fetch limits a run sends with OpenRouter's web fetch tool
-- (lib/ai-web-tools.ts): max_content_tokens per fetched page and max_uses,
-- the pages a row may fetch. NULL: no limit (OpenRouter's defaults). Reruns
-- and setups keep them.
ALTER TABLE ai_runs ADD COLUMN web_fetch_max_content_tokens INTEGER CHECK (web_fetch_max_content_tokens >= 1);
ALTER TABLE ai_runs ADD COLUMN web_fetch_max_pages INTEGER CHECK (web_fetch_max_pages >= 1);
