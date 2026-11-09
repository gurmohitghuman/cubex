-- The company and person name cleaners read some names differently from here
-- on: emoji dropped, full-width letters read as plain ones, placeholders such
-- as "n/a" left blank (no key: they never match), a bracket that never closes
-- cut off. Auto-dedupe keeps each row's key (auto_dedupe_keys) as the cleaner
-- of its day read it, so a key kept from before could miss a new row holding
-- the same value. Settings matching on company or person_name build their
-- keys again, as a new setting does (services/auto-dedupe-index.ts): every row
-- is read again from the start, rows arriving meanwhile are checked once it is
-- done, and building removes no row.
UPDATE auto_dedupe SET build_cursor = 0 WHERE match IN ('company', 'person_name');
