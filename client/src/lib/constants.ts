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
