// /api/v1 caps and budgets (split from constants.ts — 200-line guardrail).
// The programmatic surface gets its own, tighter bounds than the UI routes:
// an agent retries cleanly on a 400, so we prefer small hard caps over
// generosity. Client mirror not needed — no browser code calls /api/v1.

// Route-level JSON body cap (the 32MB global parser is skipped for the prefix
// so Bearer auth runs before any body parse; see applyServerMiddleware).
export const API_V1_MAX_JSON_BYTES = 2 * 1024 * 1024;

// Per-TOKEN request budget (keyed after validation — never on an unvalidated
// credential). Generous for an agent poll loop; a runaway script throttles its
// own token, not your other integrations.
export const API_V1_RATE_PER_MIN = 120;

// GET /v1/sheets/:id/rows paging. The page cap keeps a single tool result
// small enough not to blow up an agent's context window.
export const API_V1_DEFAULT_ROWS_PAGE = 100;
export const API_V1_MAX_ROWS_PAGE = 500;
// The MCP read_rows tool is tighter still — its results land verbatim in an
// agent's context window (design doc §4).
export const MCP_MAX_ROWS_PAGE = 100;
// read_rows / rows/query `row_ids`: the most rows one read names (services/rows-by-id.ts).
export const ROWS_BY_ID_MAX = 1000;
// Over MCP a read by id keeps rows up to about this many characters and lists
// the rest in unread_ids, as export_csv does (MCP_EXPORT_MAX_CHARS below).
export const MCP_ROWS_BY_ID_MAX_CHARS = 40_000;

// Batch caps per call. The rows-per-sheet cap still governs on top; these
// bound single-call transaction size (writer-lock hold time).
export const API_V1_MAX_APPEND_ROWS = 1000;
export const API_V1_MAX_DELETE_ROWS = 1000;
export const API_V1_MAX_BATCH_UPDATES = 1000;

export const TRANSFER_STARTS_PER_MIN = 10;
export const TRANSFER_MAX_ROWS = 10000;
export const TRANSFER_MAX_STORED_BYTES = 32 * 1024 * 1024;
export const TRANSFER_MAX_WRITER_MS = 2000;
export const TRANSFER_SCAN_BATCH = 250;

// transform_column (non-AI server-side cell transforms). Regex ReDoS guard:
// bounded pattern length + input the regex runs against (see lib/transform-ops).
export const TRANSFORM_MAX_REGEX_LEN = 200;
export const TRANSFORM_REGEX_INPUT_CAP = 10000;
// regex_extract runs on a worker thread, a page's cells at a time, before the
// page's transaction (lib/transform-regex-host.ts). A page it hasn't worked out
// in this long ends after the cells it did, the worker stopped, and the next page
// starts another; a cell that alone takes this long stops the call. A pattern can
// take seconds to hours on a long cell.
export const TRANSFORM_REGEX_PAGE_MS = 1000;
export const TRANSFORM_REGEX_WORKER_HEAP_MB = 64;
// A call walks the sheet TRANSFORM_PAGE_ROWS rows at a time, each page read, worked
// out and written in one short transaction, the server answering other requests
// between pages and the WAL copied back on the checkpoint worker's thread
// (services/column-transform-pages.ts, lib/wal-checkpointer.ts).
// It stops once it has written TRANSFORM_MAX_ROWS rows (as transfer_rows takes at
// most TRANSFER_MAX_ROWS) or worked TRANSFORM_MAX_CALL_MS, checked before each
// page; its next_cursor goes on.
// With columns that follow the target (clean, formula, lookup, auto-run), a page
// queues every row it writes for each of them: it then takes at most
// TRANSFORM_QUEUED_ROWS / (1 + those columns) rows.
export const TRANSFORM_PAGE_ROWS = 250;
export const TRANSFORM_MAX_ROWS = 10_000;
export const TRANSFORM_MAX_CALL_MS = 2000;
export const TRANSFORM_QUEUED_ROWS = 2000;
// A call's data_version bump is tried without waiting for the write lock; refused
// (another connection holds it), it is tried again this much later, up to this
// many times in all (a minute).
export const TRANSFORM_SETTLE_RETRY_MS = 500;
export const TRANSFORM_SETTLE_TRIES = 120;

// PATCH /v1/rows/:id — at most one value per possible column.
export const API_V1_MAX_PATCH_CELLS = 80;

// MCP run-start tools' sliding window, per access token (services/run-shared.ts).
// Agents can loop and every run start spends credits, so MCP gets this on top
// of the per-token request budget.
export const MCP_RUN_STARTS_PER_MIN = 30;

// Sheet copies a token may start a minute, over MCP and /api/v1 (services/sheet-copy.ts):
// each one writes as many rows as the sheet holds, and agents can loop.
export const SHEET_COPIES_PER_MIN = 5;

// export_csv (MCP) returns the CSV inline, in the agent's context, so it stops
// adding rows at this many characters and says how many more matched. Claude
// Code moves tool results over ~25k tokens out to a file, and ~50k characters
// is where clients start spilling; 40k stays under both. A whole sheet of any
// size streams from GET /api/v1/sheets/:id/export.
export const MCP_EXPORT_MAX_CHARS = 40_000;

// One-time file links (lib/file-links.ts): how long one works, and its token's
// shape (32 random bytes in hex), checked before any database lookup.
export const FILE_LINK_TTL_MINUTES = 15;
export const FILE_LINK_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

// Idempotency keys on row writes (append_rows, update_cells and their REST
// routes; lib/write-idempotency.ts): a key replays its first answer for a day,
// on the ledger runs use. A user keeps the newest KEYS_MAX of them (run and
// transfer keys don't count); a one-row update's stored answer keeps the row's
// cells up to ROW_BYTES (past that a replay leaves them out and says so).
export const IDEMPOTENT_WRITE_TTL_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENT_WRITE_KEYS_MAX = 10_000;
export const IDEMPOTENT_WRITE_ROW_BYTES = 16 * 1024;
export const IDEMPOTENT_WRITE_KEY_MAX_CHARS = 200;
// Deleted a slice at a time: a write past KEYS_MAX, and the sweep of expired
// keys, whose append slices are smaller (an append's stored answer is up to
// ~45 KB, and secure_delete zeroes every page it frees): ~1 MB a slice. A
// many-rows update keeps up to ~5 KB: its changed, without the column names
// (rows-write-keyed.ts), names up to 100 rows. With auto-dedupe on, its lists
// (auto-dedupe-answer.ts, up to 100 ids each) take it to ~9 KB.
export const IDEMPOTENT_WRITE_PRUNE_ROWS = 250;
export const IDEMPOTENT_WRITE_PRUNE_APPENDS = 25;

// list_saved_keys / GET /api/v1/saved-keys. Without a name: at most KEYS_LISTED
// keys a call (keys_count is whole; `after` pages on) and BRIEF places and
// setups a key. With a name: up to USES_LISTED of each. Every count is whole.
export const SAVED_KEYS_LISTED = 20;
export const SAVED_KEY_USES_BRIEF = 10;
export const SAVED_KEY_USES_LISTED = 50;

// How long an MCP client may keep server/discover and tools/list (2026-07-28
// ttlMs) before asking again. Cubex sends no list-changed notices, so this is
// the only freshness signal: tools that change with a new version and the
// spend a description names show within five minutes. Both answers name the token's spend cap, so they are
// private to the token (mcp/build-server.ts).
export const MCP_LIST_CACHE_TTL_MS = 5 * 60 * 1000;

// The JSON-RPC code /mcp answers a refused browser Origin with (routes/mcp.ts,
// HTTP 403). The spec names no code for it and asks that a code it doesn't
// define come from outside the JSON-RPC reserved range (-32768 to -32000);
// 403 for the HTTP status it goes with.
export const MCP_FORBIDDEN_ORIGIN_CODE = -31403;
