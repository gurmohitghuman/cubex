// The `where` every row-selecting tool takes (read_rows, export_csv,
// create_download_link, transfer_rows, transform_column) and read_rows'
// include_status, described once so the tools teach the same language
// (lib/row-filter/where.ts; services/row-filter.ts checks it against the sheet).
import { z } from 'zod';
import { FILTER_OPS } from '../lib/row-filter/ops';
import { MAX_FILTER_LIST_VALUES, MAX_WHERE_CONDITIONS, MAX_WHERE_DEPTH } from '../lib/constants-filters';

export const WHERE_LANGUAGE = 'Rows must pass every item. An item is a condition {column, operator, value} or a '
  + 'group: {"or":[items]} passes when any of its items does, {"and":[items]} when all do, and a group\'s items '
  + `can be groups, up to ${MAX_WHERE_DEPTH} deep. "enabled": false turns a condition off (kept, not counted). `
  + 'Text operators ignore case and outer '
  + 'spaces: eq, neq, contains, not_contains, starts_with, ends_with, empty and not_empty (no value); any_of and '
  + 'not_any_of take "values":["a","b"]. gt, gte, lt and lte need a number in the cell ("1,000" counts, '
  + '"1,5" doesn\'t); '
  + 'other cells never pass. date_eq, date_neq, date_gt (after), date_gte, date_lt (before) and date_lte compare '
  + 'calendar days and need a date in the cell and in value: 2024-01-31, 2024/01/31, 1/31/2024 (month first '
  + 'unless the first number is over 12), 31.1.2024 (day first), Jan 31, 2024 or 31 Jan 2024, a time after it '
  + 'ignored; other cells never pass, date_neq included. '
  + 'Run-state operators read the words AI, HTTP API and enrichment runs write into cells, so you never parse them: '
  + 'has_error (the run failed, ❌), has_result (a real value), not_run (never run), condition_not_met (kept out by '
  + 'its "Only run if" rule), running (⏳ waiting or running, ➕ adding rows), out_of_date (a result made from '
  + 'input cells that changed since; control_run mode out_of_date reruns them). They take no value, and column is '
  + 'optional: left out, a row passes when ANY run column matches ([{"operator":"has_error"}] = rows where any '
  + 'run failed). An output column of a run reads the run\'s state from its status column, so has_error on '
  + '"Email" finds the rows whose enrichment failed. Text operators compare the cell as written, status words '
  + 'included. Example: [{"column":"Industry","operator":"any_of","values":["SaaS","Fintech"]},'
  + '{"column":"Signed up","operator":"date_gte","value":"2024-01-01"},'
  + '{"or":[{"column":"Email","operator":"empty"},{"and":[{"column":"Phone","operator":"empty"},'
  + '{"column":"Country","operator":"eq","value":"US"}]}]}].';

const condition = z.object({
  column: z.string().optional()
    .describe('Column name, exactly as in the sheet. Optional for run-state operators (any run column).'),
  operator: z.enum(FILTER_OPS),
  value: z.string().optional().describe('Text, numbers and dates included ("1000"). Not for any_of / not_any_of.'),
  values: z.array(z.string()).min(1).max(MAX_FILTER_LIST_VALUES).optional()
    .describe('any_of / not_any_of only: the values.'),
  enabled: z.boolean().optional().describe('false turns the condition off. Default true.'),
});

// A group's items are conditions or groups. Kept loose here (a recursive
// schema becomes $ref definitions some clients can't read): every tool's
// `where` reaches services/row-filter.ts prepareWhere, which reads the whole
// of it with the grammar's own checks and answers in the tool's own words.
const items = z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_WHERE_CONDITIONS)
  .describe('Conditions or groups, as at the top level.');
// Strict: a group with another key ({"or":[...],"and":[...]}) is refused, never cut down to one of them.
const orGroup = z.object({ or: items }).strict();
const andGroup = z.object({ and: items }).strict();
export const whereSchema = z.array(z.union([condition, orGroup, andGroup])).min(1).max(MAX_WHERE_CONDITIONS)
  .describe(WHERE_LANGUAGE);

export const INCLUDE_STATUS_HELP = 'true: each AI, HTTP API and enrichment column\'s cell comes back as '
  + '{status, value, error} instead of its text. status is done (value holds the result), no_result (the run '
  + 'finished without a value; reason says why when Cubex wrote one, e.g. "Not found"), error (error holds what '
  + 'failed), out_of_date (a result, value or reason as above, made from input cells that changed since: a rerun '
  + 'with mode out_of_date refreshes it), condition_not_met, running or not_run. Other columns are unchanged. '
  + 'Default false.';

export const VIEW_HELP = 'A saved view of the sheet, by name or id (get_sheet lists views): its filters are '
  + 'added to `where`, and when it hides columns its visible columns are the columns unless you pass columns. '
  + '"active" reads the view the app shows. Reads through a view answer view_version: with a cursor, echo it '
  + 'as expected_view_version (and, when the view filters, expected_data_version and expected_row_generation).';
