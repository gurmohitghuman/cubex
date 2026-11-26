// The guide paragraphs for a saved setup, or one enrichment tool, called on items without a sheet (apply_setup and
// run_enrichment with items, followed with get_setup_run; guide.ts says what a guide holds).
import { ENRICH_CALL_MAX_ITEMS, SETUP_CALL_KEEP_HOURS, SETUP_CALL_MAX_ITEMS } from '../../lib/constants-setups';
import type { ToolGuide } from './guide';

// apply_setup with items.
export const SETUP_ITEMS_TEXT = [
  'With items: an input an item leaves out reads as empty, and a name the setup doesn\'t read is refused '
    + '(list_setups with setup_id lists its inputs). inputs, names and first_rows go with sheet_id only.',
  'With items, the estimate only reads: it prices each step on the items (an AI step\'s "Only run if" rule is '
    + 'checked on each one) and makes nothing. A start counts against the access token\'s run starts per minute, as '
    + 'a column run\'s does.',
  'With items, Cubex runs the setup on a working table of its own that you never see: not in the app, list_tables, '
    + 'get_workspace or the trash. Each step runs as it would on a sheet, and auto-run is never turned on there. '
    + 'What its enrichments spend shows in Settings as "A call without a sheet".',
  'The call\'s id is a setup run\'s id: get_setup_run answers it, control_setup_run pauses, resumes or cancels it, '
    + 'a run webhook named with webhook_id reports it as kind "setup" with that id as run_id, and get_run_status '
    + 'works on each step\'s run_id.',
  `A call left paused for ${SETUP_CALL_KEEP_HOURS} hours is stopped (cancelled), and its results are then kept `
    + `${SETUP_CALL_KEEP_HOURS} hours too. Then its working table is deleted and get_setup_run answers not found.`,
];

export const GET_SETUP_RUN_GUIDE: ToolGuide = {
  text: [
    'A call on items (apply_setup with items) answers running, paused, done, failed or cancelled, each step\'s state '
      + 'and run_id, and once it has finished, results: each item, in the order sent, with its status, error and '
      + 'outputs by column (null when it has no value).',
    'A cell where a step failed, found nothing or was kept out by its "Only run if" rule is never given as an '
      + 'output: it reads null, and the item\'s status says so (error, running, condition_not_met, no_result, '
      + 'done, or not_run when nothing was made), with error naming the column that failed and why.',
    `Results come ${SETUP_CALL_MAX_ITEMS} items at a time (limit, up to ${SETUP_CALL_MAX_ITEMS}): next_from is `
      + 'where the next page starts (pass it as results_from), null after the last. create_download_link with '
      + 'setup_call_id (instead of sheet_id) saves every item\'s inputs and outputs as a CSV.',
    `Results are kept ${SETUP_CALL_KEEP_HOURS} hours after the call finishes (keep_until). A call left paused for `
      + `${SETUP_CALL_KEEP_HOURS} hours is stopped: its status is cancelled and error_message says why.`,
    'With wait_seconds it answers when the run finishes, pauses or resumes, or the time is up.',
  ],
};

// run_enrichment with items.
export const ENRICH_ITEMS_TEXT = [
  `With items: 1-${ENRICH_CALL_MAX_ITEMS.toLocaleString('en-US')} of them, each keyed by the tool's input names `
    + '(get_enrichment lists them); fields picks the output fields to keep (default every one). Use it to enrich a few records for '
    + 'a script or another app; for several steps on items, apply_setup with items. It takes only tool_id, items, '
    + 'fields, estimate_only, max_cost_usd, allow_unpriced and webhook_id.',
  'With items, the estimate only reads: it prices the items as the estimate on a sheet prices rows (items that '
    + 'reuse an answer found for the same inputs cost $0) and makes nothing. A tool with no known price is refused, '
    + 'unless allow_unpriced. Started, its spend limit is the estimate\'s high end.',
  'With items, the call is an enrichment run on a working table of its own: get_run_results gives each item\'s '
    + 'status, fields and error, control_run stops it, and webhook_id names a run webhook for it. Each output field '
    + 'keeps its name; status_column names the column with each item\'s status (Status, or Status 2 for a tool that '
    + 'answers a status field, as an email check does).',
  `A call left paused for ${SETUP_CALL_KEEP_HOURS} hours is stopped, and its results are then kept `
    + `${SETUP_CALL_KEEP_HOURS} hours too. What it spends shows in Settings as "A call without a sheet".`,
];
