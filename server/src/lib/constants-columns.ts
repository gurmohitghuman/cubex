// Column details (get_sheet's column_details) and descriptions. Guards, not quotas.

// A prompt, formula or request URL in column_details is cut to this many
// characters, or to the larger size for the columns the call names, while
// their full texts fit in one shared budget (past it, they are cut too).
export const COLUMN_DETAIL_TEXT_CHARS = 300;
export const COLUMN_DETAIL_FULL_TEXT_CHARS = 10_000;
export const COLUMN_DETAILS_FULL_TEXT_BUDGET = 40_000;
// column_details keeps whole entries until about this many characters, then
// gives the rest by name and kind only (an agent's context on a wide sheet).
export const COLUMN_DETAILS_MAX_CHARS = 30_000;
// Columns get_sheet counts (filled, empty, errors) in one call: each is read
// on every row, so a call counts the columns it names, or the first ones.
export const COLUMN_COUNTS_MAX_COLUMNS = 20;
// Columns a get_sheet call can name to see in full.
export const COLUMN_DETAILS_MAX_NAMED = 50;

// A column's or a sheet's description: a sentence or a short paragraph.
export const MAX_COLUMN_DESCRIPTION_CHARS = 1000;
export const MAX_SHEET_DESCRIPTION_CHARS = 2000;
