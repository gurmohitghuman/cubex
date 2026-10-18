// Row-query extras (read_rows and REST rows/query: aggregates and nested
// paths), the grid's search and its value counts. Guards, not quotas.

// group_by columns in one aggregate read, and aggregates in one read.
export const MAX_GROUP_BY_COLUMNS = 3;
export const MAX_AGGREGATES = 10;
// Groups an aggregate read returns: the largest, by row count.
export const AGGREGATE_TOP_GROUPS = 1000;
// Different groups one aggregate read may meet before it stops ("too many
// groups"): each is held in memory until the walk ends. At 100,000 groups of
// 200-character values that is about 60 MB, briefly.
export const AGGREGATE_MAX_GROUPS = 100_000;
// A group's value as returned (and kept while counting): longer values are
// cut, and grouped by a hash of their whole text so they stay apart.
export const GROUP_VALUE_MAX_CHARS = 200;
// An MCP aggregate answer keeps groups until about this many characters (an
// agent's context), then says truncated.
export const MCP_MAX_GROUP_CHARS = 40_000;

// A nested path inside a JSON cell (columns: [{column, path}]): its keys, and
// the characters in one key or in an output name.
export const MAX_PATH_DEPTH = 5;
export const MAX_PATH_KEY_CHARS = 200;

// Search (services/sheet-search.ts): the text, and how many matching cells a
// count goes up to before it says "10,000+".
export const MAX_SEARCH_CHARS = 200;
export const SEARCH_COUNT_CAP = 10_000;
