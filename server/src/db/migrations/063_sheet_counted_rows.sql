-- Each sheet's rows when last counted (lib/row-counts.ts): the home, GET /v1/tables and list_tables show it, marked
-- as updating, while a newer count is made, as after a restart. Written when a count lands, never by a row write,
-- so it can be behind: the count in memory is the one that holds.
-- Counted once here, so the first home after this update shows every count at once (about 1 s per 10M rows).
ALTER TABLE sheets ADD COLUMN counted_rows INTEGER NOT NULL DEFAULT 0;
UPDATE sheets SET counted_rows =
  (SELECT COUNT(*) FROM rows r WHERE r.sheet_id = sheets.id AND r.user_id = sheets.user_id);
