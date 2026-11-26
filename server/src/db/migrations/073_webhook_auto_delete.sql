-- Auto-delete on a webhook sheet (services/webhook-auto-delete*.ts, docs/webhooks.md#auto-delete): the sheet keeps
-- its newest keep_rows rows, and older rows the webhook added leave once every auto-run column has run on them
-- (and, with a success_column, once that column holds a result), copied first to copy_to_sheet_id when one is
-- set. Rows that leave are gone at once, not kept in the trash. One per webhook; it goes when the webhook does.
-- "Newest" is the bottom of the sheet, where events land: row_generation_seen is the sheet's row_generation when
-- it was saved, and a sort or an import since (which move rows) pauses it until it is saved again.
-- copy_to_sheet_id has no foreign key on purpose: a destination that is gone pauses auto-delete (paused_*), so a
-- row is never deleted without its copy.
CREATE TABLE webhook_auto_delete (
  source_id TEXT PRIMARY KEY REFERENCES webhook_sources(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'actions_finish',
  keep_rows INTEGER NOT NULL DEFAULT 100,
  success_column TEXT,
  copy_to_sheet_id TEXT,
  row_generation_seen INTEGER NOT NULL DEFAULT 0,
  -- Why no row leaves until the person acts: 'success_column' (gone from the sheet), 'copy_gone' (the destination
  -- in the trash or deleted), 'copy' (the destination refused the rows: full, or out of columns), 'order' (rows
  -- moved since it was saved); with its words. The first two clear once fixed, 'copy' once a slice gets through,
  -- and any once the settings are saved.
  paused_reason TEXT,
  paused_message TEXT,
  paused_at TEXT,
  rows_deleted INTEGER NOT NULL DEFAULT 0,
  last_deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_webhook_auto_delete_sheet ON webhook_auto_delete(sheet_id);
