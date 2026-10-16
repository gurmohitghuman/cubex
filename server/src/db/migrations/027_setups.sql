-- Setups (services/setup-*.ts): a named copy of a chain of filled columns (AI,
-- HTTP API, enrichment, clean and formula, with their "Only run if" rules and
-- auto-run) that can be used again on another sheet. A copy, not a link: a
-- sheet it was used on never changes when the setup does. spec is the steps,
-- in an order where each step comes after the columns it reads, the inputs
-- (columns the chain reads and no step makes) and the saved keys it names
-- (names only, never a value): lib/setups/spec.ts.
CREATE TABLE setups (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  spec TEXT NOT NULL,                       -- JSON, lib/setups/spec.ts
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_setups_user_name_ci ON setups(user_id, LOWER(name));
