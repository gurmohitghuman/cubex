// Waterfall columns (lib/waterfall/, services/waterfall-*.ts).

// Steps one waterfall may have, and inputs it may map.
export const WATERFALL_MAX_STEPS = 12;
export const WATERFALL_MAX_INPUTS = 20;
// Alternatives one step may list for its required inputs, and inputs in one alternative.
export const WATERFALL_MAX_ALTERNATIVES = 8;
// A step's label (shown in the "answered by" column) and an input's label.
export const WATERFALL_LABEL_MAX_CHARS = 60;
// An AI step's prompt, an HTTP step's URL / body / one header value.
export const WATERFALL_PROMPT_MAX_CHARS = 8_000;
export const WATERFALL_HTTP_URL_MAX_CHARS = 2_000;
export const WATERFALL_HTTP_BODY_MAX_CHARS = 20_000;
export const WATERFALL_HTTP_HEADERS_MAX = 30;
// A trace keeps what came back that wasn't an answer, and why a step ended, cut to these lengths.
export const WATERFALL_TRACE_VALUE_CHARS = 200;
export const WATERFALL_TRACE_DETAIL_CHARS = 300;
// A dry run's answers are replayed at no cost by any run of the same step on the same inputs for
// this many days; a row's own step answers (kept while the row runs) are dropped after it too.
export const WATERFALL_ANSWER_KEEP_DAYS = 7;
// The estimate reads a step's answer rate from this column's newest runs (at most this many),
// once they reached the step on at least WATERFALL_RATE_MIN_ROWS rows.
export const WATERFALL_RATE_RUNS = 20;
export const WATERFALL_RATE_MIN_ROWS = 20;
// An AI step answers in at most this many output tokens (a value, not an essay).
export const WATERFALL_AI_MAX_TOKENS = 1_000;
// An AI step's temperature: a lookup, not creative writing.
export const WATERFALL_AI_TEMPERATURE = 0.2;
// A dry run takes this many rows unless rows are picked (at most WATERFALL_DRY_MAX_ROWS).
export const WATERFALL_DRY_ROWS = 3;
export const WATERFALL_DRY_MAX_ROWS = 10;
// waterfall_column dry_run waits this long for the dry run to finish before answering.
export const WATERFALL_DRY_WAIT_SECONDS = 25;
// A formula step or check whose worker restarted under it is asked this many times before the row counts
// as running away (a row that hung is answered "took too long" on the next try).
export const WATERFALL_FORMULA_ROW_TRIES = 3;
// An index of another sheet's column that only waterfall lookup steps read is let go once no waterfall
// column's newest run reads it, and never in its first WATERFALL_LOOKUP_GRACE_MINUTES (a run starting
// on it may not be in the list yet). That list is read again at most every WATERFALL_LOOKUP_NEEDS_MS.
export const WATERFALL_LOOKUP_GRACE_MINUTES = 10;
export const WATERFALL_LOOKUP_NEEDS_MS = 60_000;
