// Hiring tables (services/hiring-*.ts, lib/hiring/): companies hiring for chosen roles.
// A new table starts with at most this many role titles (one search each; more rows can come later).
export const HIRING_MAX_ROLES = 20;
export const HIRING_MAX_ROLE_CHARS = 100;
export const HIRING_MAX_PLACE_CHARS = 100;
// Roles each search adds at most (a list run's results per row), and the default.
export const HIRING_DEFAULT_PER_SEARCH = 25;
export const HIRING_DEFAULT_POSTED_DAYS = 30;
export const HIRING_MAX_POSTED_DAYS = 365;
// A company's Role titles: the first few kept titles, then "…"; its Links: the newest few.
export const HIRING_TITLES_SHOWN = 5;
export const HIRING_LINKS_SHOWN = 3;
export const HIRING_NEW_TITLES_SHOWN = 3;
// The free count (services/job-count.ts): searches counted at most, and how long one count may take.
export const HIRING_COUNT_MAX_SEARCHES = 20;
export const HIRING_COUNT_TIMEOUT_MS = 5_000;
// A check waits for its search's run and that run's rows: how often it looks.
export const HIRING_CHECK_POLL_MS = 2_000;
// The summary per company (services/hiring-summarize.ts): Roles rows read a
// slice (the reads yield between slices), and Companies rows read, compared
// and written in one bulk writer slice.
export const HIRING_SUMMARY_READ_ROWS = 2_000;
export const HIRING_SUMMARY_WRITE_ROWS = 500;
// Companies summed up at once. Past this many, Roles is read once per batch of
// companies (a hash of the company key picks its batch), each read keeping only
// its batch's totals, so memory stays bounded whatever the number of companies.
export const HIRING_SUMMARY_MAX_COMPANIES = 100_000;
// A batch may grow to this many times the most before the batches are made smaller.
export const HIRING_SUMMARY_BATCH_SLACK = 2;
// Past the most, the first read counts the companies from one key in this many
// (by the same hash), to know how many batches to make.
export const HIRING_SUMMARY_COUNT_SAMPLE = 64;
// A walk over the companies kept in memory lets other requests in after this long.
export const HIRING_SUMMARY_SLICE_MS = 25;
