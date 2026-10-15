// Removing duplicate rows (services/dedupe-*.ts, lib/dedupe/).

// A check reads rows in pages and works out their keys between requests: it
// lets other requests in whenever DEDUPE_SLICE_MS of key work has passed, even
// mid-page (a phone or domain match takes up to ~20 µs a row). A page starts
// at DEDUPE_FIRST_PAGE_ROWS rows; it halves when its read took longer than
// DEDUPE_READ_MS (cells holding whole API responses make each row slow to
// read) and doubles, within the bounds, when the read took under a quarter of that.
export const DEDUPE_SLICE_MS = 25;
export const DEDUPE_READ_MS = 20;
export const DEDUPE_FIRST_PAGE_ROWS = 2_000;
export const DEDUPE_MIN_PAGE_ROWS = 100;
export const DEDUPE_MAX_PAGE_ROWS = 10_000;
// Rows deleted per transaction, one journal chunk each, with a WAL checkpoint
// after each (services/dedupe-remove.ts). Far fewer than other heavy jobs: a
// delete dirties about one page per row in the row-id index (ids are random)
// and SQLite zeroes what it frees (secure_delete). Measured at 1M rows: 1,000
// rows a commit, with the auto-checkpoint, held the server up to 1.2 s; 250
// rows a commit and a checkpoint of their own, about 5 ms each (p99 170 ms).
export const DEDUPE_DELETE_CHUNK_ROWS = 250;
// A key longer than this many characters is kept as its sha256, so a million
// long keys (several columns, a whole address) stay a few dozen MB.
export const DEDUPE_KEY_HASH_CHARS = 64;
// What a check shows: the first groups found (in row order), each with up to
// DEDUPE_SAMPLE_REMOVED of its removed rows, and the largest group. Cell
// values shown are cut to DEDUPE_SAMPLE_CHARS characters.
export const DEDUPE_SAMPLE_GROUPS = 5;
export const DEDUPE_SAMPLE_REMOVED = 3;
export const DEDUPE_SAMPLE_CHARS = 200;
// A phone number the phone metadata can't place still matches by its digits
// when it has at least this many.
export const DEDUPE_PHONE_MIN_DIGITS = 7;
