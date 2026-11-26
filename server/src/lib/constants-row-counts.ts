// Row counts of the home and get_workspace's all_tables (lib/row-counts.ts).

// Rows one slice of a count reads, on the server's thread, before it lets other work run: about 10 ms (100,000 rows
// took 20 to 25 ms, on a 4.7 GB database of 10 sheets of 1M rows and in tests/unit/row-counts-speed.test.ts).
export const ROW_COUNT_SLICE_ROWS = 50_000;
// A count during which the sheet's rows changed is made again, up to this many times in all. The last one is kept
// then: a sheet whose rows keep changing is counted again when its count is next asked for.
export const ROW_COUNT_TRIES = 3;
// A count's write to sheets.counted_rows refused because another connection held the write lock is tried again this
// much later (lib/write-when-free.ts), until it is written.
export const ROW_COUNT_WRITE_RETRY_MS = 1_000;
// GET /v1/tables and get_workspace (all_tables) wait this long at most for the counts of changed sheets; past it they
// answer the
// last count, saying it may be out of date. An agent's call never waits on a big count.
export const ROW_COUNT_API_WAIT_MS = 2_000;
// The home's wait for the counts it showed as updating (GET /api/tables/row-counts) answers by this time at most,
// well under the 65 s keep-alive, as the sheet's change poll does; the home then asks again for those still counted.
export const ROW_COUNT_HOLD_MS = 20_000;
