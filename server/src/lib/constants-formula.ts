// Formula columns (lib/formula/, services/formula-*.ts).

// A formula is one JavaScript expression of at most this many characters.
export const FORMULA_MAX_CHARS = 4_000;
// A formula in the worker (lib/formula/qjs.ts): memory, the QuickJS stack,
// and how long one row may run by QuickJS's own clock. The stack stays small
// on purpose: QuickJS counts its own stack, but a deep recursion also uses the
// thread's, and above about 128 KB some (a deeply nested JSON.parse) overflow
// the thread's first, which breaks the WASM instance. At 64 KB they all stop
// inside QuickJS (measured with half of Node's stack already in use), still
// leaving ~330 nested calls and JSON ~4,000 levels deep.
export const FORMULA_MEMORY_BYTES = 64 * 1024 * 1024;
export const FORMULA_STACK_BYTES = 64 * 1024;
export const FORMULA_ROW_MS = 50;
// Compiling a formula (and loading Lodash, ~10 ms) may take this long.
export const FORMULA_SETUP_MS = 500;
// QuickJS's clock isn't read inside a long built-in call (an indexOf or a
// split over a huge string), so the API thread also waits by wall clock
// (lib/formula/host.ts): a request to the worker gets its own time plus
// FORMULA_ROW_MS plus this much, and opening a formula FORMULA_OPEN_CAP_MS;
// past that the worker is stopped. That is the longest the API thread waits.
export const FORMULA_WAIT_SLACK_MS = 150;
export const FORMULA_OPEN_CAP_MS = 1_000;
// The worker thread's own JavaScript heap (cells in flight, results).
export const FORMULA_WORKER_HEAP_MB = 256;
// A cell holding JSON (text starting with { or [) reaches the formula parsed,
// unless it nests deeper than this: then it stays text.
export const FORMULA_JSON_MAX_DEPTH = 100;
// A row the formula couldn't work out shows "❌ <the error>", cut to this long.
export const FORMULA_ERROR_CHARS = 120;
// A fill or follow pass stops after this many rows ran out of time or memory:
// the formula is too slow, not the data.
export const FORMULA_MAX_RUNAWAYS = 3;
// An agent's formula_column (MCP, /api/v1) answers once the fill is done or
// after this long; the app's dialog waits less, then the tab shows ⏳ until
// the fill's end reloads it (as clean columns do).
export const FORMULA_WAIT_MS = 10_000;
export const FORMULA_APP_WAIT_MS = 3_000;
// Preview: the first rows (in row order) where an input holds a value, read
// from at most FORMULA_PREVIEW_SCAN_ROWS rows; each value shown cut to
// FORMULA_PREVIEW_CELL_CHARS (a whole API response can be a cell). A pure read.
export const FORMULA_PREVIEW_ROWS = 8;
export const FORMULA_PREVIEW_SCAN_ROWS = 2_000;
export const FORMULA_PREVIEW_CELL_CHARS = 300;
// The plain words a formula is written from (by AI, services/formula-ai.ts),
// kept with the column.
export const FORMULA_WORDS_MAX_CHARS = 1_000;
// Writing a formula with AI: the model sees the first FORMULA_SAMPLE_ROWS
// rows: per text column up to FORMULA_SAMPLE_VALUES values, per JSON column
// its shape cut to FORMULA_SAMPLE_JSON_CHARS (lib/formula-prompt.ts). Few
// rows, because a JSON column can hold a whole API response in every cell.
export const FORMULA_SAMPLE_ROWS = 20;
export const FORMULA_SAMPLE_VALUES = 5;
export const FORMULA_SAMPLE_JSON_CHARS = 1_500;
