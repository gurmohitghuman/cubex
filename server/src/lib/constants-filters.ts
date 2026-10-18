// Row filters (lib/row-filter): the `where` of read_rows, REST rows/query,
// CSV export, transfer_rows and transform_column, and the grid's column filters.

// Conditions in one `where`, OR groups included (an "Only run if" rule's cap too).
export const MAX_WHERE_CONDITIONS = 50;
// Groups inside groups in one `where`: a top-level group is 1 deep.
export const MAX_WHERE_DEPTH = 5;
// Values in one any_of / not_any_of list.
export const MAX_FILTER_LIST_VALUES = 200;
// Characters in one value.
export const MAX_FILTER_VALUE_CHARS = 1000;
// A filtered read walks the sheet a slice of rows at a time and lets other
// requests in between (lib/filtered-scan.ts). A slice starts small, at
// FILTER_SLICE_ROWS, since a `where` of 50 conditions checks a row in about
// 8 µs; it halves when one took longer than FILTER_SLICE_MS and doubles,
// within the bounds, when one took under a quarter of that. Measured at 1M
// rows, one condition checks a row in about 0.5 µs and a check of every run
// column in about 1.5 µs.
export const FILTER_SLICE_ROWS = 4_000;
export const FILTER_SLICE_MIN_ROWS = 2_000;
export const FILTER_SLICE_MAX_ROWS = 200_000;
export const FILTER_SLICE_MS = 25;
// Saved views (services/views.ts): a guard, not a quota.
export const MAX_VIEWS_PER_SHEET = 50;
export const MAX_VIEW_NAME_CHARS = 100;
export const MAX_VIEW_DESCRIPTION_CHARS = 1000;
