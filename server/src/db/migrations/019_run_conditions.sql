-- "Only run if" rules (lib/run-condition.ts) on AI, HTTP API and enrichment
-- runs. An AI run keeps its rule beside its prompt; an HTTP or enrichment run
-- keeps it in its config JSON (config.runIf). Rows the rule kept out of a run
-- hold "⏭️ Condition not met" and are counted here, apart from the rows run.
ALTER TABLE ai_runs ADD COLUMN run_if TEXT;
ALTER TABLE ai_runs ADD COLUMN condition_skipped_rows INTEGER;
ALTER TABLE http_runs ADD COLUMN condition_skipped_rows INTEGER;
-- Auto-run's own rule; where_json keeps the condition lists saved before rules.
ALTER TABLE autorun_columns ADD COLUMN run_if TEXT;
