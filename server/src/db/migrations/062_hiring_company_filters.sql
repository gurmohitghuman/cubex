-- A hiring table's filters on Companies (lib/hiring/company-filters.ts,
-- services/hiring-summarize-write.ts): a company gets a row on Companies only
-- with at least min_roles roles in Roles, and only when its website isn't one
-- of leave_out_companies. Their roles are still searched and paid for, and
-- stay in Roles. A row already on Companies is kept up to date either way.
-- Tables made before: no filter.
ALTER TABLE hiring_signals ADD COLUMN min_roles INTEGER NOT NULL DEFAULT 1;
ALTER TABLE hiring_signals ADD COLUMN leave_out_companies TEXT NOT NULL DEFAULT '[]'; -- JSON array of websites

-- Companies a check's summary kept off Companies by those filters (no row, for now).
ALTER TABLE hiring_checks ADD COLUMN companies_kept_off INTEGER NOT NULL DEFAULT 0;
