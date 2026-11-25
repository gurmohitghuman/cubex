-- A run column's auto-run start delay (services/autorun-pick.ts): a row waits until it has gone this many seconds
-- without being queued again (a waiting row) or written (a new row) before auto-run takes it, so a row still being
-- filled in (by hand, a webhook in parts, another column) runs once it is done. 0: at once, as before.
ALTER TABLE autorun_columns ADD COLUMN start_delay_s INTEGER NOT NULL DEFAULT 0;

-- The waiting rows that are due, found without reading the rest (autorun-pick.ts).
CREATE INDEX idx_autorun_pending_due ON autorun_pending(autorun_id, created_at);
