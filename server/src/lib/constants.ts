// AI / OpenRouter constants live in constants-ai.ts (200-line guardrail split);
// re-exported here so every call site keeps importing from './constants'.
export * from './constants-ai';

// Positive integer from the environment, else the fallback. A garbage value must
// not become NaN: several consumers treat NaN as "no limit".
const envInt = (name: string, fallback: number): number => {
  const raw = parseInt(process.env[name] || '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
};

// Centralized regexes used by multiple routes
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// RELAXED, Google-Sheets-like column-name rule used by EVERY column-creation path
// (manual add/rename, AI/HTTP new columns, webhook mapping, CSV import) via the
// shared helpers in lib/column-names.ts. Real-world names carry symbols
// ("# Revenue", "$ ARR", "Q1 (2024)") and tooling prefixes ("__source_lsn" from
// Postgres CDC); storage handles them fine (jsonPath double-quotes the JSON key;
// /column refs normalize via normalizeColumnName), so rejecting them is gratuitous
// friction. We allow any name EXCEPT: (a) no alphanumeric at all (symbol-only like
// "%", which normalizes to an empty /token), (b) the path-unsafe " and \ (stripped
// by sanitizeColumnName before this is tested), (c) control chars. Cap mirrors
// sanitizeColumnName (200). The one reserved internal name is handled separately.
export const RELAXED_COLUMN_NAME_PATTERN = /^(?=.*[A-Za-z0-9])[^"\\\x00-\x1F\x7F]{1,200}$/;
// Column names Cubex reserves because they collide with grid internals. ONLY
// __rowIndex is unsafe: row objects are built as { __rowIndex, ...row.data } and
// getRowId reads it, so a data column of that name breaks row identity.
// (__rowNumber/__addColumn are pseudo-COLUMN ids in a different namespace — data
// columns get opaque col_xxxx colIds — so they're safe as data NAMES.)
export const RESERVED_COLUMN_NAMES = new Set(['__rowIndex']);
export const API_KEY_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

// Password rules for the single account (lib/password.ts). The max stops a
// huge body from tying up an argon2 hash.
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 256;

// Failed login / setup / change-password attempts allowed per window, shared by
// the whole instance (lib/limits.ts). Env-overridable for test harnesses.
export const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_RATE_MAX = envInt('LOGIN_RATE_MAX', 10);

// Cache TTLs
export const HTTP_REQUEST_CACHE_TTL_MS = 5 * 60 * 1000;

// Limits. Guards against one oversized import or runaway script, not quotas:
// there is no cap on tables or sheets. An upload streams to disk and is read
// back in slices (lib/csv-import-parse.ts), so this caps disk use and import
// time, not memory: 500 MB holds a million rows of about 30 columns.
export const MAX_CSV_UPLOAD_BYTES = envInt('MAX_CSV_UPLOAD_MB', 500) * 1024 * 1024;
export const MAX_TABLE_NAME_LENGTH = 100;
export const MAX_SHEET_NAME_LENGTH = 100; // match MAX_TABLE_NAME_LENGTH; Google Sheets allows ~100
export const MAX_TEMPLATE_NAME_LENGTH = 200;
export const MIN_API_KEY_VALUE_LENGTH = 10;
// Per-sheet caps. Counts every column type (manual, AI Output, AI Data,
// HTTP master, HTTP extracted) and every row regardless of how it got there.
// Enforced via countColumnsAndRows() in lib/sql-helpers.ts at every
// column-creating + row-creating site. A million rows is comfortable: reads
// page from the index, and every whole-sheet job (import, sort, column rename
// or delete, runs) streams or works in slices, so memory stays flat and the
// server keeps answering. Raise it via env if you need more.
export const MAX_COLUMNS_PER_SHEET = envInt('MAX_COLUMNS_PER_SHEET', 200);
export const MAX_ROWS_PER_SHEET = envInt('MAX_ROWS_PER_SHEET', 1_000_000);

// lib/column-repair.ts reads a sheet's rows in slices of this many between
// requests (about 25 ms each), so its full-sheet key scan never blocks one.
export const COLUMN_REPAIR_SLICE_ROWS = 20_000;
// Rows written per transaction by heavy jobs (import, sort, column rename and
// delete, run placeholders): each slice stays well under 100 ms, so the server
// answers other requests between slices (lib/slices.ts).
export const HEAVY_SLICE_ROWS = 5_000;
// A journaled heavy job (a sort, a CSV import's clean-up) that fails half-way
// keeps its sheet busy and is retried in the background, waiting this long
// before the first retry and doubling up to the cap (lib/sheet-busy.ts).
export const HEAVY_JOB_RETRY_MS = 2_000;
export const HEAVY_JOB_RETRY_MAX_MS = 60_000;
// A run's leftover ⏳ clear (lib/run-placeholders.ts) that failed leaves the run
// marked 'clearing', which holds off sorts and renames. Every interval, clears
// marked longer ago than the stale age are run again (a million-row clear
// takes well under a minute).
export const RUN_CLEANUP_SWEEP_MS = 60_000;
export const RUN_CLEANUP_STALE_MINUTES = 5;

// HTTP API defaults
export const HTTP_REQUEST_TIMEOUT_MS = 30000;
// Bounds for a run's own request timeout (requestConfig.timeout).
export const HTTP_MIN_TIMEOUT_MS = 1_000;
export const HTTP_MAX_TIMEOUT_MS = 120_000;
export const HTTP_DEFAULT_BATCH_SIZE = 5;
// Max in-run request fan-out for ONE HTTP run (the batch size clamp in
// http-runner). Deliberately lower than the AI fan-out: most third-party APIs
// rate-limit well below this, and a burst of hundreds of concurrent requests
// mostly buys 429s. Env-overridable for APIs that allow more.
export const HTTP_MAX_CONCURRENCY = envInt('HTTP_MAX_CONCURRENCY', 20);
// Requests an HTTP column preview makes at once (it previews up to 20 rows, so
// one at a time could run past its 60 s deadline).
export const HTTP_PREVIEW_CONCURRENCY = 5;

// Sidequest worker pool size (queue.ts): how many AI/HTTP runs execute at once.
// Runs started beyond this wait as 'pending' until a worker frees up.
export const WORKER_POOL_SIZE = envInt('SIDEQUEST_MAX_CONCURRENT_JOBS', 4);

// Incoming webhooks (POST /api/webhooks/:token). The app's only unauthenticated
// write surface — every number here is a guard. See docs/webhooks.md.
//
// Body cap: 512 KB per POST, vs the 32 MB global express.json limit. The webhook
// router declares its OWN express.json({ limit }) so this small cap governs the
// public path. Oversize -> 413.
export const WEBHOOK_MAX_BODY_BYTES = 512 * 1024;
// Per-token ingestion rate limit (token-bucket keyed on the webhook source),
// ~10 records/sec, burst 20, so a misbehaving sender can't flood a sheet.
// Excess -> 429.
export const WEBHOOK_RATE_PER_SEC = 10;
export const WEBHOOK_RATE_BURST = 20;
// Idle entries in the per-token bucket Map are evicted after this long so
// deleted/rotated webhooks don't linger in memory.
export const WEBHOOK_BUCKET_IDLE_EVICT_MS = 5 * 60 * 1000;
// Structural guard on the parsed payload (runs AFTER JSON.parse, BEFORE any
// extraction/write). Bounds json_set cost and delivery-store size. Over -> 400.
export const WEBHOOK_MAX_JSON_DEPTH = 10;
export const WEBHOOK_MAX_JSON_NODES = 5000;
// Per-cell size caps, two tiers (matches Clay: 8KB "basic" cells, 200KB
// "action/enrichment" cells). BASIC = hand-entered / typed / CSV / API-written /
// webhook cells; ENRICHMENT = machine-generated AI output + HTTP-extracted
// values, which legitimately run long. Enforced at every cell-write site
// (clampCellChars in csv-safety.ts); mirrored in client/src/lib/constants.ts.
export const CELL_MAX_BASIC = 8000;
export const CELL_MAX_ENRICHMENT = 200000;
// A single extracted webhook value is truncated to this many chars before it's
// written into a cell. Webhook cells are the "basic" tier (a mapped field
// shouldn't write a huge cell), so this is CELL_MAX_BASIC.
export const WEBHOOK_MAX_CELL_CHARS = CELL_MAX_BASIC;
// Hard cap on the TOTAL serialized size of one appended row's cells, enforced
// before the INSERT. Bounds the worst case where many wide mappings each write
// up to WEBHOOK_MAX_CELL_CHARS — without this, 80 cols × 8 KB ≈ 625 KB/row would
// let one sender bloat the SQLite file to multi-GB before the row cap.
// Over -> the append still creates the row but extra cells are dropped (the row
// is never silently lost). 64 KB is generous for honest enrichment payloads.
export const WEBHOOK_MAX_ROW_DATA_BYTES = 64 * 1024;
// Max length of a stored mapping JSONPath. The client builder emits short paths;
// this bounds a hand-crafted API call and the per-delivery extraction cost.
export const WEBHOOK_MAX_JSONPATH_LEN = 500;
// Raw-payload retention per webhook source: keep the newest deliveries up to BOTH
// bounds (count AND bytes), whichever is smaller. The appended ROW always stays;
// pruning only drops the stored raw JSON in webhook_deliveries.
export const WEBHOOK_RAW_KEEP_COUNT = 1000;
export const WEBHOOK_RAW_KEEP_BYTES = 10 * 1024 * 1024; // ~10 MB
// Hard lifetime cap on the NUMBER of webhook_deliveries rows kept per source.
// Payload pruning above only clears the raw JSON but keeps the (tiny) metadata
// row forever — so a "fill a sheet, delete the rows, repeat" cycle would grow the
// table unboundedly. This deletes the oldest delivery ROWS beyond the cap. Set
// well above WEBHOOK_RAW_KEEP_COUNT so the "raw no longer retained" UI state
// still works for the recent window; a metadata row is ~a few hundred bytes, so
// 5000 rows ≈ a couple MB/source worst case.
export const WEBHOOK_DELIVERY_KEEP_COUNT = 5000;
// :token URL-segment format (base64url of 32 random bytes -> 43 chars). A cheap
// regex pre-check rejects malformed tokens with a generic 404 before any DB work.
export const WEBHOOK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// ---- Personal access tokens (/api/v1, /mcp) — docs/mcp.md ----
// Full token: cubex_pat_ + 64 hex chars (32 random bytes). Cheap-format regex
// rejects malformed Bearer values with a generic 401 before any hashing/DB work
// (same posture as WEBHOOK_TOKEN_PATTERN).
export const ACCESS_TOKEN_PREFIX = 'cubex_pat_';
export const ACCESS_TOKEN_RAW_BYTES = 32;
export const ACCESS_TOKEN_PATTERN = /^cubex_pat_[0-9a-f]{64}$/;
// How much of the full token is kept as the display prefix ("cubex_pat_ab3"):
// the fixed prefix plus three random characters.
export const ACCESS_TOKEN_DISPLAY_PREFIX_CHARS = ACCESS_TOKEN_PREFIX.length + 3;
// Names: same charset as API_KEY_NAME_PATTERN plus spaces, bounded length.
export const ACCESS_TOKEN_NAME_PATTERN = /^[a-zA-Z0-9 _-]{1,60}$/;
export const MAX_ACCESS_TOKENS_PER_USER = 10;
// 'write' and 'run' imply 'read'; 'secrets' requires 'run' (never alone).
export const ACCESS_TOKEN_SCOPES = ['read', 'write', 'run', 'secrets'] as const;
export const MAX_ACCESS_TOKEN_EXPIRY_DAYS = 365;
// last_used_at is throttled through an in-memory guard so token auth never
// puts a DB write on every request's hot path (the single writer belongs to
// UI autosave).
export const ACCESS_TOKEN_LAST_USED_WRITE_INTERVAL_MS = 60 * 1000;
// /api/v1 body/rate/paging/batch caps live in api-v1-constants.ts.

