// A whole number sent as text ("12"): digits only, with nothing around them but
// whitespace. MCP's whole-number options read it as the number
// (mcp/tool-helpers.ts lenientInt), and so does REST rows/query's
// max_chars_per_cell (services/row-query-input.ts), so both surfaces take the
// same strings. "1.5", "1e3", "0x10", "-3" and "" are not digits: they come back
// as they were, for the caller's check to refuse.
export const DIGITS_TEXT = /^\s*\d+\s*$/;

export const digitsAsNumber = (v: unknown): unknown =>
  typeof v === 'string' && DIGITS_TEXT.test(v) ? Number(v.trim()) : v;
