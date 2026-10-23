-- "Check again" on an AI visibility table (services/ai-visibility-check*.ts):
-- the answers there now kept in dated copies of its two sheets (migration
-- 047's sheet copy), two columns on the questions sheet comparing with them
-- (a lookup of the old "Named by" and a formula saying what changed), then
-- every question asked again. A check is journaled stage by stage, so a
-- restart finishes the free part; it never asks the engines (paid) on its own.
-- A check that stopped (a restart, a refusal) is picked up by the next one:
-- its copies kept, only the engines it didn't start asked.
CREATE TABLE ai_visibility_checks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  visibility_id TEXT NOT NULL REFERENCES ai_visibility(id) ON DELETE CASCADE,
  label TEXT NOT NULL,                  -- the day most kept answers were asked (YYYY-MM-DD, the asker's day)
  answers_at TEXT NOT NULL,             -- the newest of those answers (UTC), for how old they are
  stage TEXT NOT NULL CHECK (stage IN ('copying', 'comparing', 'asking', 'done', 'stopped')),
  questions_copy_id TEXT REFERENCES sheets(id) ON DELETE SET NULL,
  sites_copy_id TEXT REFERENCES sheets(id) ON DELETE SET NULL,
  -- The names it chose, before making anything (a restart uses the same ones).
  questions_copy_name TEXT NOT NULL,
  sites_copy_name TEXT,
  brands TEXT NOT NULL,                 -- JSON array: the brands looked for that day (yours first)
  named_by_column TEXT NOT NULL,        -- "Named by on <label>": the lookup into the questions copy
  change_column TEXT NOT NULL,          -- "Change since <label>"
  -- The engine runs it started, each as it started, [{column, runId, rows}];
  -- runId '' for an engine with nothing to ask (done for this check).
  runs TEXT NOT NULL DEFAULT '[]',
  problems TEXT NOT NULL DEFAULT '[]',  -- what didn't go to plan, in plain words
  -- http_runs' highest rowid when the check was made: a run above it (but its
  -- own) asked the engines since, so the next check copies again.
  run_floor INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ai_visibility_checks ON ai_visibility_checks(visibility_id, created_at);
