// The trash (services/trash-*.ts, migration 036) and the sheet change log
// (services/sheet-history.ts, migration 037). Re-exported from constants.ts.

// How many days deleted rows, sheets and tables are kept (Settings); 0 deletes them at once.
export const TRASH_DAYS_DEFAULT = 30;
export const TRASH_DAYS_MAX = 90;
// How often the trash looks for what has been kept long enough (and prunes the change log).
export const TRASH_SWEEP_MS = 10 * 60 * 1000;
// A grid delete larger than the server takes in one call comes in several: the
// calls name the first one's batch and land in it, while it is this recent.
export const TRASH_GROUP_MS = 10 * 60 * 1000;
// Rows moved into a batch, put back, or deleted for good with their sheet, per
// transaction, each followed by a PASSIVE WAL checkpoint (lib/slices.ts
// runInCheckpointedSlices): moving a row dirties about one page of the row-id
// index (ids are random) and SQLite zeroes what it frees. Measured at 1M rows:
// 5,000 rows a slice took 110-190 ms and SQLite's own checkpoints added stalls
// of a second or more; 250 rows and a checkpoint each, 2-6 ms and 5-13 ms (p99),
// as removing duplicates found (lib/constants-dedupe.ts).
export const TRASH_SLICE_ROWS = 250;
// A batch's own rows go for good in their order (no random index): more at a time.
export const TRASH_PURGE_BATCH_ROWS = 2_000;
// The app's grid sends a big delete in calls of this many rows (one batch in
// the trash): each call is one transaction (2,000 rows about 80 ms at 1M rows).
export const GRID_DELETE_CALL_ROWS = 2_000;
// Checking whether a batch's old places are free reads this many rows per slice.
export const TRASH_PLACE_CHECK_ROWS = 20_000;
// A restore of up to this many rows answers once they are back; a bigger one
// answers at once and goes on in the background (the trash shows how far it got).
export const TRASH_RESTORE_WAIT_ROWS = 20_000;
// Rows restored by pick (a few found in a batch) in one call, in one transaction.
export const TRASH_RESTORE_PICK_MAX = 1_000;
// Looking inside a batch: rows per page, and rows a search reads per call (it
// says where it stopped, and the next call goes on from there).
export const TRASH_ROWS_PAGE_DEFAULT = 50;
export const TRASH_ROWS_PAGE_MAX = 500;
export const TRASH_SEARCH_SCAN_ROWS = 50_000;
// Items one restore or delete-for-good names at most.
export const TRASH_IDS_MAX = 50;
// Items per page of the trash list.
export const TRASH_LIST_PAGE = 100;

// The change log keeps this many days of a sheet's history.
export const CHANGE_LOG_DAYS = 90;
export const CHANGE_LOG_PAGE_DEFAULT = 50;
export const CHANGE_LOG_PAGE_MAX = 200;
// Rows of history pruned per transaction.
export const CHANGE_LOG_PRUNE_SLICE = 5_000;
