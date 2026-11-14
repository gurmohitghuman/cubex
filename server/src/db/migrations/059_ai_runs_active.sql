-- The AI runs going now, as http_runs (014) and setup_runs (028) already have them: get_workspace lists
-- every sheet's (services/workspace-overview.ts) and get_sheet one sheet's (services/sheet-runs.ts). Without
-- it each read walks every AI run the account ever had; with it, only the few going now. A query must repeat
-- this WHERE word for word to use it. An index only: no data changes.
CREATE INDEX idx_ai_runs_active ON ai_runs(sheet_id) WHERE status IN ('pending', 'running', 'paused');
