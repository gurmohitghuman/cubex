-- One-time links that move a CSV file into or out of a sheet over plain HTTP,
-- made by an MCP agent so the file's contents never pass through its context
-- (lib/file-links.ts). Like a presigned URL, the link is the credential: only
-- its sha256 is stored, and it covers one sheet and one operation, works once,
-- expires within minutes, and stops working with the access token that made it.
CREATE TABLE file_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_token_id TEXT NOT NULL REFERENCES access_tokens(id) ON DELETE CASCADE,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('upload', 'download')),
  token_hash TEXT NOT NULL UNIQUE,
  -- upload: {"mode": "append" | "replace"}; download: {"columns"?, "where"?}
  options TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_file_links_user_expires ON file_links(user_id, expires_at);
CREATE INDEX idx_file_links_sheet ON file_links(sheet_id);
CREATE INDEX idx_file_links_access_token ON file_links(access_token_id);
