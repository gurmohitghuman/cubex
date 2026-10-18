// Usage history (services/usage.ts): rows a read returns at most (the totals
// always cover the whole range; a CSV has every row), and runs a CSV reads per
// page between other requests.
export const USAGE_DEFAULT_ROWS = 200;
export const USAGE_MAX_ROWS = 1_000;
// An agent's page (MCP get_usage): smaller, so a read stays readable in its context.
export const USAGE_MCP_MAX_ROWS = 200;
export const USAGE_CSV_PAGE = 1_000;
// The longest custom range, in days.
export const USAGE_MAX_RANGE_DAYS = 3_660;
