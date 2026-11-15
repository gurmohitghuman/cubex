// Undoing a run (lib/run-undo/, services/run-undo*.ts, migration 041). A run's
// undo journal is kept this many days after it starts (a week covers "that run
// was wrong" found the next working day), then deleted, a slice at a time.
export const UNDO_KEEP_DAYS = 7;
// Journal rows put back per write transaction, in rowid order, when no clean,
// formula or lookup column reads the run's columns (services/run-undo.ts).
export const UNDO_SLICE_ROWS = 2_000;
// An undo also queues each row it puts back once for every clean, formula and
// lookup column reading a column it restores, in the same transaction
// (lib/autorun-mark.ts markDerivedInputs); on rows with random ids each queued
// row writes a page of its own. With R such columns a slice holds this many /
// (1 + R) journal rows (1,000 at 1, 500 at 3, still 10 on a full sheet of 200
// columns), commits with SQLite's own checkpoint off, and the WAL is copied
// back on the checkpoint worker's thread (lib/bulk-slices.ts).
// Measured at 200,000 rows on random ids, the checkpoints then on the API
// thread after each slice. Three formulas: slices up to 45 ms,
// checkpoints up to 62 ms, the whole undo 23 to 24 s in the background. In
// slices of 2,000 rows SQLite's own checkpoint ran inside 93 of 102 commits
// (slices up to 222 ms, the whole undo 14 to 15 s). One formula: slices up to
// 42 ms, checkpoints up to 49 ms, 9 s (up to 97 ms, 6 s).
export const UNDO_QUEUE_ROWS = 2_000;
// An undo of up to this many rows answers once it is done; a bigger one
// answers at once and goes on in the background (its state says how far).
export const UNDO_WAIT_ROWS = 20_000;
// Journal rows deleted per transaction once they aren't needed (their own order: cheap).
export const UNDO_DROP_SLICE_ROWS = 5_000;
// An undo that fails this many times in a row stops (the run can be undone again).
export const UNDO_RETRY_MAX = 5;
// A run that ended before it wrote a row drops its journal (lib/run-undo/unused.ts): it first reads the
// journal, to be sure it holds nothing but the run's ⏳, this many / (1 + its columns) rows a turn (a turn
// checks each row's cell of every column). Measured at 200,000 rows: a turn of 20,000 rows took up to 26 ms
// with 2 columns, 89 ms with 10 and 166 ms with 20; sized so, up to 22 ms whatever the columns, the whole
// check as long as before (0.2 s with 2 columns, 0.8 s with 10, 1.6 s with 20).
export const UNDO_EMPTY_CHECK_ROWS = 20_000;
