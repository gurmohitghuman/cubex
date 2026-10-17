// Lookup columns (lib/lookup/, services/lookup-*.ts).

// A key longer than this many characters is kept as its hash (lib/lookup/normalize.ts).
export const LOOKUP_KEY_MAX_CHARS = 500;
// Contains looks at the first this-many characters of each cell of the other sheet.
export const LOOKUP_TEXT_MAX_CHARS = 1_000;
// Contains needs a value of at least this many characters (the text index works on 3-letter pieces).
export const LOOKUP_CONTAINS_MIN_CHARS = 3;
// A first match or a list is picked from at most this many matches, and contains counts at most
// this many: past it the cell says so instead of guessing.
export const LOOKUP_MAX_MATCHES = 10_000;
// "All matches" writes at most this many (the default when none is given: LOOKUP_LIST_DEFAULT).
export const LOOKUP_LIST_MAX = 100;
export const LOOKUP_LIST_DEFAULT = 10;
// Keeping a looked-up column's keys current (services/lookup-maintain.ts): each step is one short
// transaction of at most LOOKUP_STEP_ROWS rows or LOOKUP_STEP_MS.
export const LOOKUP_STEP_ROWS = 2_000;
export const LOOKUP_STEP_MS = 60;
// A fill waiting for the other sheet (sorting, importing…) looks again this often, and an auto-run
// tick that had to wait comes back after LOOKUP_FOLLOW_RETRY_MS.
export const LOOKUP_WAIT_POLL_MS = 500;
export const LOOKUP_FOLLOW_RETRY_MS = 2_000;
// An auto-run tick waits at most this long for the other sheet's keys to be brought up to date
// (in the lookup worker), then comes back; a fill asks in rounds of LOOKUP_STEP_ROUND_MS until they are.
export const LOOKUP_FOLLOW_MAINTAIN_MS = 200;
export const LOOKUP_STEP_ROUND_MS = 1_000;
// Answers kept per pass (a value looked up again in the same pass isn't matched again).
export const LOOKUP_CACHE_ENTRIES = 20_000;
// Contains: the needle's rarest trigrams are matched first when the rarest is in at most this many
// rows; a needle made only of common trigrams uses the text index's own phrase match.
export const LOOKUP_RARE_TRIGRAM_ROWS = 20_000;
// Contains: at most this many of a value's trigrams are counted to find its rarest (spread over the
// value), candidates are read this many at a time, and one value may take at most LOOKUP_MATCH_MS
// to match (past it the cell says so: a longer value is faster).
export const LOOKUP_SAMPLE_TRIGRAMS = 12;
export const LOOKUP_CANDIDATES_PER_READ = 2_048;
export const LOOKUP_MATCH_MS = 2_000;
// Dropped sources' keys are deleted, and looked-up sheets kept current, by a background round in
// the lookup worker this often (services/lookup-host.ts).
export const LOOKUP_PURGE_TICK_MS = 1_000;
// An agent's lookup_column (MCP, /api/v1) answers once the fill is done or after this long; the
// app's dialog waits less.
export const LOOKUP_WAIT_MS = 10_000;
export const LOOKUP_APP_WAIT_MS = 3_000;
// Preview: the first LOOKUP_PREVIEW_ROWS rows (of the first LOOKUP_PREVIEW_SCAN_ROWS) whose value
// isn't empty. Without the other sheet's keys built yet, it reads the first
// LOOKUP_PREVIEW_OTHER_ROWS rows of the other sheet and says so. Values shown are cut to
// LOOKUP_PREVIEW_CELL_CHARS.
export const LOOKUP_PREVIEW_ROWS = 8;
export const LOOKUP_PREVIEW_SCAN_ROWS = 2_000;
export const LOOKUP_PREVIEW_OTHER_ROWS = 50_000;
export const LOOKUP_PREVIEW_CELL_CHARS = 300;
