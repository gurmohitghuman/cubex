-- The release check (services/release-check.ts): Settings → Account → Version
-- shows the running version and the latest release on GitHub. update_check: 1
-- (the default) asks GitHub's releases API at most once a day, 0 never asks.
-- latest_release: the last good answer, as JSON {version, published_at,
-- checked_at}; NULL before the first one, and after the check is turned off
-- (turning it off deletes it). release_tried_at: when the last check was sent,
-- whatever came back, so a restart doesn't ask again within the day.
-- Defaulted or nullable, no backfill: nothing stored changes.
ALTER TABLE settings ADD COLUMN update_check INTEGER NOT NULL DEFAULT 1;
ALTER TABLE settings ADD COLUMN latest_release TEXT;
ALTER TABLE settings ADD COLUMN release_tried_at TEXT;
