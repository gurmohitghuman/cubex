-- A social research table (services/social-create.ts): a table made from a
-- topic, with a Searches sheet whose list columns (one per platform, set up and
-- not run) add the posts they find to that platform's Posts sheet, keeping the
-- posts found before (enrichment_list_seen, migration 061), and the steps the
-- person chose set up on each Posts sheet and not run. This row holds what the
-- table was made from, so the app's guide, get_workspace and Find posts know it.
CREATE TABLE social_research (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  searches_sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  comments_sheet_id TEXT REFERENCES sheets(id) ON DELETE SET NULL,
  posts_sheets TEXT NOT NULL,           -- JSON: { "<platform>": "<its Posts sheet id>" }
  topic TEXT NOT NULL,
  steps TEXT NOT NULL,                  -- JSON array: the steps set up (transcript, breakdown, creator, comments)
  min_views INTEGER,                    -- the Top posts view's filters (null: none)
  min_comments INTEGER,
  posted_within_days INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_social_research_searches ON social_research(searches_sheet_id);
CREATE INDEX idx_social_research_user ON social_research(user_id, table_id);
