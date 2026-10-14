// Clean data columns (services/clean-column.ts, clean-fill.ts, clean-follow.ts).

// An agent's clean_column (MCP, /api/v1) answers once the fill is done or
// after this long, whichever comes first: a sheet of up to a few hundred
// thousand rows answers with its counts, a bigger one with "filling".
export const CLEAN_WAIT_MS = 10_000;
// The app's Clean data dialog waits this long, then the tab shows ⏳ until the
// fill's end reloads it.
export const CLEAN_APP_WAIT_MS = 3_000;
// Preview: the first rows (in row order) whose source holds a value, read
// from at most CLEAN_PREVIEW_SCAN_ROWS rows. A pure read.
export const CLEAN_PREVIEW_ROWS = 8;
export const CLEAN_PREVIEW_SCAN_ROWS = 2_000;
// Auto-run on a clean column follows its source: a write to the source cleans
// that row again within this long in the API process (a run worker's write
// waits for the auto-run sweep), and a tick with more to do than
// CLEAN_FOLLOW_TICK_MS goes on after that pause, so other auto-runs get a turn.
export const CLEAN_FOLLOW_KICK_MS = 300;
export const CLEAN_FOLLOW_TICK_MS = 250;
// The name, company, email, domain and phone cleaners (lib/clean/) read a
// value longer than this as not one of those and return '' rather than work
// through it.
export const MAX_CLEAN_FIELD_CHARS = 1_000;
