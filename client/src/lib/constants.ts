// Mirrors of server-side limits in `server/src/lib/constants.ts`. Keep in sync.
// (Row/column caps are server-configurable, so the client doesn't mirror them;
// the server's error message names the limit when one is hit.)
export const MAX_SHEET_NAME_LENGTH = 100;
// Per-cell size cap for hand-entered cells (mirrors server CELL_MAX_BASIC). Used
// by the client pre-guard in useCellOps so an oversized typed/pasted edit is
// truncated + toasted at edit time — a server 400 would reject the whole
// autosave batch and strand other queued edits. The server stays authoritative.
export const CELL_MAX_BASIC = 8000;

// Rows fetched on first table open. AG Grid only paints ~viewport+rowBuffer rows,
// so a large initial page is mostly network/JSON overhead — noticeable over a
// real network. load-more pulls the next page on scroll-end. Also the floor for
// a silent (background) reload so it doesn't shrink the window below the baseline.
export const INITIAL_ROW_LOAD = 300;
// Silent (background) reloads (hooks/sheet/reloadWindow.ts) refetch the held
// rows from the top in pages of SILENT_RELOAD_PAGE_ROWS (the server's GET cap),
// up to SILENT_RELOAD_MAX_ROWS (4 requests). A viewport deeper than that cap
// minus SILENT_RELOAD_BELOW_ROWS refetches a cap-sized slice starting
// SILENT_RELOAD_LEAD_ROWS above its first rendered row instead.
export const SILENT_RELOAD_PAGE_ROWS = 1000;
export const SILENT_RELOAD_MAX_ROWS = 4000;
export const SILENT_RELOAD_BELOW_ROWS = 1000;
export const SILENT_RELOAD_LEAD_ROWS = 250;
// Search (hooks/sheet/useSheetSearch.ts): a match outside the held rows loads
// a window of SEARCH_JUMP_ROWS starting SEARCH_JUMP_LEAD_ROWS above it; the
// typed text waits SEARCH_DEBOUNCE_MS of quiet before it searches; the
// server caps the text (MAX_SEARCH_CHARS in server lib/constants-query.ts).
export const SEARCH_JUMP_ROWS = 1000;
export const SEARCH_JUMP_LEAD_ROWS = 100;
export const SEARCH_DEBOUNCE_MS = 250;
export const MAX_SEARCH_CHARS = 200;

// The "type it in" effect when a cell gets its value (aggrid/typingTicker.ts):
// per character, capped per cell however long the value is, and how many cells
// may type at once (past that, a big batch shows its values straight away).
export const TYPING_MS_PER_CHAR = 20;
export const TYPING_MAX_MS = 600;
export const TYPING_MAX_ACTIVE = 200;

// AI run concurrency (in-run request fan-out). Mirrors server/src/lib/constants.ts
// (the server clamps; the slider max must match). Free OpenRouter models
// rate-limit above FREE_MODEL_CONCURRENCY_WARN, so the modal warns past it.
export const MAX_AI_CONCURRENCY = 100;
export const FREE_MODEL_CONCURRENCY_WARN = 10;
// HTTP column requests at once: the most a column may set (mirrors server HTTP_MAX_CONCURRENCY).
export const HTTP_MAX_CONCURRENCY = 100;
// HTTP column retries (mirror server HTTP_RETRY_DEFAULT / HTTP_RETRY_MAX) and the
// response mapping path that writes the HTTP status code (HTTP_STATUS_PATH).
export const HTTP_RETRY_DEFAULT = 3;
export const HTTP_RETRY_MAX = 5;
export const HTTP_STATUS_PATH = '@status';
// Highest per-row web search limit (mirrors server MAX_SEARCHES_PER_ROW).
export const MAX_SEARCHES_PER_ROW = 10;

// How long an acked-but-not-loud-reloaded cell edit stays eligible to be
// re-overlaid onto a SILENT background reload (run completion / Stop). The
// overlay only exists to bridge the sub-second window where a silent reload's
// GET read pre-PUT server state; past this TTL the server is authoritative, so
// the entry is dropped — otherwise a later run that legitimately changes the
// same cell would be masked by the user's older saved value. Also bounds the
// recentlySaved map's growth between reloads.
export const RECENTLY_SAVED_TTL_MS = 10000;

// Password rules. MUST match server/src/lib/constants.ts — the server is
// authoritative; the client mirrors them so the form can say "too short"
// before submitting.
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 256;

// While the server is busy with a big change to a sheet (a sort, an import, a
// column rename or delete on a large sheet), it answers cell saves with a
// "busy" 409. Autosave keeps the edits queued and tries again at this interval
// until the change finishes (server lib/sheet-busy.ts).
export const SHEET_BUSY_RETRY_MS = 2000;

// "Run First Rows" on an AI or HTTP API column: the rows it offers, and the
// most it takes (server MAX_FIRST_ROWS).
export const FIRST_ROWS_DEFAULT = 10;
export const FIRST_ROWS_MAX = 1000;

// Enrichments. Mirrors server/src/lib/constants-enrich.ts: the rows "Run on 5
// rows" takes, and the highest per-row limit an estimate or run accepts.
export const ENRICH_TEST_ROWS = 5;
export const ENRICH_MAX_ROW_CAP_USD = 1000;
// How often the drawer's Test and Run steps read a run's lean status while it
// runs (GET /api/enrich/runs/:id); the grid itself follows the run over SSE.
export const ENRICH_RUN_POLL_MS = 1500;
// A waterfall dry run takes this many rows unless rows are picked (at most WATERFALL_DRY_MAX_ROWS).
// Mirrors server/src/lib/constants-waterfall.ts.
export const WATERFALL_DRY_ROWS = 3;
export const WATERFALL_DRY_MAX_ROWS = 10;
// The Settings spend card's windows, in days (server ENRICH_SPEND_WINDOWS).
export const ENRICH_SPEND_WINDOWS = [7, 30, 90] as const;

// Auto-run (server constants-enrich.ts): an enrichment column's default daily
// cap, and an HTTP API column's default and highest rows a day. The CSV
// import's auto-run notice counts the rows of at most the first part of a big
// file and scales the rest by size ("about").
export const AUTORUN_DEFAULT_DAILY_CAP_USD = 5;
export const AUTORUN_HTTP_DEFAULT_DAILY_ROWS = 500;
export const AUTORUN_HTTP_MAX_DAILY_ROWS = 1_000_000;
export const AUTORUN_IMPORT_COUNT_BYTES = 8 * 1024 * 1024;

// Clean data dialog: the preview (a free read of the first rows, before and
// after) is asked for this long after the last change to the form.
export const CLEAN_PREVIEW_DELAY_MS = 400;
// Formula dialog: the same free preview, asked for this long after the last
// keystroke in the formula (a formula is typed more than picked).
export const FORMULA_PREVIEW_DELAY_MS = 500;
// Lookup columns (server lib/constants-lookup.ts): the preview's wait after a change, "all matches"
// (at most LOOKUP_LIST_MAX, LOOKUP_LIST_DEFAULT when not set), contains' shortest value.
export const LOOKUP_PREVIEW_DELAY_MS = 400;
export const LOOKUP_LIST_MAX = 100;
export const LOOKUP_LIST_DEFAULT = 10;
export const LOOKUP_CONTAINS_MIN_CHARS = 3;

// Longest pasted cURL command the HTTP column dialog sends (mirrors server CURL_MAX_CHARS).
export const CURL_MAX_CHARS = 100_000;

// Remove duplicates dialog: the check (a free read of the whole sheet) is
// asked for this long after the last change to the columns or keep choice.
// Checking and removing a million rows can take longer than the client's
// usual 30 s request timeout, so both wait up to DEDUPE_REQUEST_TIMEOUT_MS.
export const DEDUPE_CHECK_DELAY_MS = 400;
export const DEDUPE_REQUEST_TIMEOUT_MS = 10 * 60_000;
// The auto-dedupe dialog looks again this often while the sheet's keys build or checks wait.
export const AUTO_DEDUPE_POLL_MS = 2_000;
// Rows picked from a trash batch go back at most this many a call (server TRASH_RESTORE_PICK_MAX).
export const TRASH_RESTORE_PICK_MAX = 1_000;

// Column filters (mirror server/src/lib/constants-filters.ts): values in one
// "is any of" list, and characters in one value.
export const MAX_FILTER_LIST_VALUES = 200;
export const MAX_FILTER_VALUE_CHARS = 1000;
// Rules in one filter (server MAX_WHERE_CONDITIONS), and how deep the filter
// panel nests groups below its top level (the server takes MAX_WHERE_DEPTH 5;
// a top level of "any" is a group itself).
export const MAX_WHERE_CONDITIONS = 50;
export const MAX_FILTER_PANEL_DEPTH = 3;

// Most typed columns one AI run can fill (mirrors server MAX_OUTPUT_COLUMNS_PER_RUN).
export const MAX_OUTPUT_COLUMNS_PER_RUN = 20;

// A saved hidden-columns change waits this long for a load to show it (useSheetViews).
export const PENDING_HIDDEN_MS = 5000;

// Descriptions (mirror server/src/lib/constants-columns.ts): characters in a column's and a sheet's.
export const MAX_COLUMN_DESCRIPTION_CHARS = 1000;
export const MAX_SHEET_DESCRIPTION_CHARS = 2000;

// Rows a grid delete sends per call (server lib/constants-trash.ts GRID_DELETE_CALL_ROWS).
export const GRID_DELETE_CALL_ROWS = 2_000;

// Try with sample data (server services/sample-table.ts): making it fills its
// free columns before it answers. The guide names the AI column it set up and
// the duplicate check it shows (server lib/sample/setup.ts).
export const SAMPLE_CREATE_TIMEOUT_MS = 90_000;
export const SAMPLE_AI_COLUMN = 'Good fit (Output)';
export const SAMPLE_DEDUPE_COLUMNS = [{ column: 'Email', match: 'email' as const }];

// A run can be undone this many days after it starts (server lib/constants.ts UNDO_KEEP_DAYS).
export const UNDO_KEEP_DAYS = 7;
// How often "Undo last run" reads how far a big undo got, and failed reads in a row before it gives up.
export const UNDO_POLL_MS = 1_500;
export const UNDO_POLL_MISSES = 5;
