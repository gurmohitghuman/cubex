-- Reusing paid enrichment answers across runs and sheets (services/enrich-reuse.ts).

-- How many days a found answer is reused instead of calling treg again (0: never).
ALTER TABLE settings ADD COLUMN enrich_reuse_days INTEGER NOT NULL DEFAULT 30;

-- A row's stored answer that a later run may reuse names its lookup (the tool
-- and the request it sent, hashed: lib/enrich-reuse-key.ts) and when treg
-- answered it. Set only for a found answer from a real call, kept whole enough
-- to read again, so a set key always means a completed result with an answer;
-- writing the row's result again sets it anew or clears it. Rows deleted, a
-- sheet deleted: the result goes, and its key with it.
ALTER TABLE http_results ADD COLUMN reuse_key TEXT;
ALTER TABLE http_results ADD COLUMN answered_at TEXT;
CREATE INDEX idx_http_results_reuse ON http_results(user_id, reuse_key, answered_at)
  WHERE reuse_key IS NOT NULL;

-- How many rows a run filled from an earlier answer, at no cost.
CREATE TABLE enrich_run_reuse (
  run_id TEXT PRIMARY KEY REFERENCES http_runs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  reused_rows INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
