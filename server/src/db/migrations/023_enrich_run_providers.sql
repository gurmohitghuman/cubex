-- Per provider, what an enrichment run's treg calls did, for get_run_status:
-- the providers a waterfall tried (its _treg.tried) or the one a single tool
-- was served by, counted as each answer arrives (services/enrich-providers.ts).
-- A replayed answer adds nothing: its calls were counted when they ran.
-- Counters, not a log: a status poll reads a run's few rows, never its calls.
CREATE TABLE enrich_run_providers (
  run_id TEXT NOT NULL REFERENCES http_runs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,                   -- treg's provider slug, e.g. contactout
  tried INTEGER NOT NULL DEFAULT 0,        -- asked (a skipped provider was not)
  hits INTEGER NOT NULL DEFAULT 0,          -- answered with something (hit or weak)
  misses INTEGER NOT NULL DEFAULT 0,        -- answered, found nothing
  errors INTEGER NOT NULL DEFAULT 0,        -- failed, rate limits included
  rate_limited INTEGER NOT NULL DEFAULT 0,  -- of the errors, answered 429
  skipped INTEGER NOT NULL DEFAULT 0,       -- not asked (over the row's budget, cooling down…)
  cost_micro INTEGER NOT NULL DEFAULT 0,    -- what treg charged for this provider's answers
  cooling_until TEXT,                       -- left out of the run's waterfalls until then (its 429s)
  PRIMARY KEY (run_id, provider)
);
