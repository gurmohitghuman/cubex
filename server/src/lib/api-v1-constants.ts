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
export const MCP_EFFICIENT_ROWS_ENABLED = ['1', 'true'].includes(
  (process.env.MCP_EFFICIENT_ROWS_ENABLED ?? '').toLowerCase(),
);

// transform_column (non-AI server-side cell transforms). Regex ReDoS guard:
// bounded pattern length + input the regex runs against (see lib/transform-ops).
// The whole transform runs synchronously in one txn under a wall-clock budget so
// a 10k-row sheet can't pin the event loop indefinitely.
export const TRANSFORM_MAX_REGEX_LEN = 200;
export const TRANSFORM_REGEX_INPUT_CAP = 10000;
export const TRANSFORM_MAX_WRITER_MS = 2000;

// PATCH /v1/rows/:id — at most one value per possible column.
export const API_V1_MAX_PATCH_CELLS = 80;

// MCP run-start tools' sliding window, per access token (services/run-shared.ts).
// Agents can loop and every run start spends credits, so MCP gets this on top
// of the per-token request budget.
export const MCP_RUN_STARTS_PER_MIN = 30;

// export_csv (MCP) returns the CSV inline, in the agent's context, so it stops
// adding rows at this many characters and says how many more matched. Claude
// Code moves tool results over ~25k tokens out to a file, and ~50k characters
// is where clients start spilling; 40k stays under both. A whole sheet of any
// size streams from GET /api/v1/sheets/:id/export.
export const MCP_EXPORT_MAX_CHARS = 40_000;
