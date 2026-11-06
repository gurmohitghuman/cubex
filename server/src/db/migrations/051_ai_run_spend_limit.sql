-- A hard spend limit per AI run (services/ai-spend-gate.ts). spend_limit_usd:
-- what the run may spend in all (OpenRouter's charge plus the user's own
-- provider key, as its usage record counts them, migration 033); NULL: no
-- limit. A run with one starts a row only while what it spent, plus the most
-- its rows still out can cost, plus the most this row can cost stays within
-- it; otherwise it waits for rows out, or pauses with pause_reason
-- 'spend_limit' (migration 042) and its rows not started stay ⏳. A resume
-- can raise it.
ALTER TABLE ai_runs ADD COLUMN spend_limit_usd REAL;

-- What an AI run's rows still out can cost, held while their calls are out,
-- one row per run and worker generation, in micro-USD. A run's worker reads
-- every hold of its run in the transaction that starts a row, so the rows an
-- earlier worker still has out after a pause and a resume count too. A worker
-- drops its own hold when it ends; another generation's hold stops counting
-- once a call that old must have ended (the AI call deadline, plus slack).
-- run_id is a plain id like enrich_holds': calls in flight still finish when
-- their run goes with a deleted sheet, and the worker drops its own hold.
-- Boot deletes them all, since no worker survives a restart.
CREATE TABLE ai_run_holds (
  run_id TEXT NOT NULL,
  worker_generation INTEGER NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hold_micro INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (run_id, worker_generation)
) WITHOUT ROWID;
