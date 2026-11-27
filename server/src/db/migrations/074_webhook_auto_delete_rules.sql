-- Auto-delete's second mode (services/webhook-auto-delete*.ts, docs/webhooks.md#auto-delete): with mode 'rules',
-- older rows the webhook added are deleted once they pass where_json (a where in read_rows' language), instead of
-- once every auto-run column has run on them. NULL in mode 'actions_finish', and for every auto-delete before this.
-- A rename of a column they name rewrites them (lib/webhook-columns.ts); rules that can't be checked (a column they
-- name is gone) pause auto-delete with paused_reason 'rules' until they or the sheet change.
ALTER TABLE webhook_auto_delete ADD COLUMN where_json TEXT;
