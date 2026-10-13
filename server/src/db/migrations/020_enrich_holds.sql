-- What enrichment batches may still spend, held while their calls are out
-- (services/enrich-holds.ts). The daily limit and a run's spend limit count the
-- ledger, which only moves once a call is answered, and several runs size their
-- batches at once in their own worker threads: without a hold each could buy
-- the same remaining room. A batch takes its hold (rows x per-row cap) in the
-- transaction that checks the limits, rows give their share back as they
-- settle, and the batch drops the rest when it ends. One row per run and
-- worker generation; boot deletes them all, since no worker survives a restart.
-- run_id is a plain id like the ledger's: a deleted run's calls in flight still
-- finish, and the batch drops its own hold.
CREATE TABLE enrich_holds (
  run_id TEXT NOT NULL,
  worker_generation INTEGER NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hold_micro INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (run_id, worker_generation)
);
CREATE INDEX idx_enrich_holds_user ON enrich_holds(user_id);
