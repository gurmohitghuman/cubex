// The `where` every row-selecting tool takes (read_rows, export_csv,
// create_download_link, transfer_rows, transform_column) and read_rows'
// include_status, described once so the tools teach the same language
// (lib/row-filter/where.ts; services/row-filter.ts checks it against the sheet).
import { z } from 'zod';
import { FILTER_OPS } from '../lib/row-filter/ops';
import { MAX_FILTER_LIST_VALUES, MAX_WHERE_CONDITIONS } from '../lib/constants-filters';

export const WHERE_LANGUAGE = 'Rows must pass every item. An item is a condition {column, operator, value} or an OR '
  + 'group {"or":[conditions]} that passes when any of its conditions does. Text operators ignore case and outer '
  + 'spaces: eq, neq, contains, not_contains, empty and not_empty (no value); any_of and not_any_of take '
  + '"values":["a","b"]. gt, gte, lt and lte need a number in the cell ("1,000" counts, "1,5" doesn\'t); '
  + 'other cells never pass. '
  + 'Run-state operators read the words AI, HTTP API and enrichment runs write into cells, so you never parse them: '
  + 'has_error (the run failed, ❌), has_result (a real value), not_run (never run), condition_not_met (kept out by '
  + 'its "Only run if" rule), running (⏳ waiting or running, ➕ adding rows). They take no value, and column is '
  + 'optional: left out, a row passes when ANY run column matches ([{"operator":"has_error"}] = rows where any '
  + 'run failed). An output column of a run reads the run\'s state from its status column, so has_error on '
  + '"Email" finds the rows whose enrichment failed. Text operators compare the cell as written, status words '
  + 'included. Example: [{"column":"Industry","operator":"any_of","values":["SaaS","Fintech"]},'
  + '{"or":[{"column":"Email","operator":"empty"},{"column":"Phone","operator":"empty"}]}].';

const condition = z.object({
  column: z.string().optional()
    .describe('Column name, exactly as in the sheet. Optional for run-state operators (any run column).'),
  operator: z.enum(FILTER_OPS),
  value: z.string().optional().describe('Text, numbers included ("1000"). Not for any_of / not_any_of.'),
  values: z.array(z.string()).min(1).max(MAX_FILTER_LIST_VALUES).optional()
    .describe('any_of / not_any_of only: the values.'),
});

const orGroup = z.object({ or: z.array(condition).min(1).max(MAX_WHERE_CONDITIONS) });
export const whereSchema = z.array(z.union([condition, orGroup])).min(1).max(MAX_WHERE_CONDITIONS)
  .describe(WHERE_LANGUAGE);

export const INCLUDE_STATUS_HELP = 'true: each AI, HTTP API and enrichment column\'s cell comes back as '
  + '{status, value, error} instead of its text. status is done (value holds the result), no_result (the run '
  + 'finished without a value; reason says why when Cubex wrote one, e.g. "Not found"), error (error holds what '
  + 'failed), condition_not_met, running or not_run. Other columns are unchanged. Default false.';
