-- AI visibility tables (services/ai-visibility-*.ts, lib/ai-visibility/): a
-- table Cubex made to ask AI engines a list of buyer questions. Its questions
-- sheet holds one enrichment column per engine (set up, not run, until the
-- person asks: a setup-only run as migration 043 has them, with setup_only 2
-- for "set up by a template, never run" beside 1 for a restore) and free
-- formula columns that read the answers; its sites sheet takes the sources
-- each answer cites. This row holds what the table was made from: the brands
-- the formulas look for (yours first), your site's domain, the country the
-- questions are asked from and the engines. The columns themselves are found
-- by what fills them, never by name.
CREATE TABLE ai_visibility (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  questions_sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  sites_sheet_id TEXT REFERENCES sheets(id) ON DELETE SET NULL,
  brand TEXT NOT NULL,
  competitors TEXT NOT NULL DEFAULT '[]',
  domain TEXT,
  country TEXT NOT NULL,
  engines TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_ai_visibility_questions ON ai_visibility(questions_sheet_id);
CREATE INDEX idx_ai_visibility_user ON ai_visibility(user_id, table_id);
