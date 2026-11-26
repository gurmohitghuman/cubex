// The guides of the tools that call a saved setup, or one enrichment tool, on items without a sheet (guide.ts says
// what a guide holds).
import { SETUP_CALL_KEEP_HOURS, SETUP_CALL_MAX_ITEMS } from '../../lib/constants-setups';
import type { ToolGuide } from './guide';

export const SETUP_CALL_GUIDES: Record<string, ToolGuide> = {
  call_setup: {
    text: [
      'An input an item leaves out reads as empty, and a name the setup doesn\'t read is refused (list_setups with '
        + 'setup_id lists its inputs).',
      'The estimate only reads: it prices each step on the items (an AI step\'s "Only run if" rule is checked on '
        + 'each one) and makes nothing. A start counts against the access token\'s run starts per minute, as a '
        + 'column run\'s does.',
      'Cubex runs the setup on a working table of its own that you never see: not in the app, list_tables, '
        + 'get_workspace or the trash. Each step runs as it would on a sheet, and auto-run is never turned on '
        + 'there. What its enrichments spend shows in Settings as "A call without a sheet".',
      'The call\'s id is a setup run\'s id: a run webhook named with webhook_id reports it as kind "setup" with that '
        + 'id as run_id, and get_run_status works on each step\'s run_id.',
      `A call left paused for ${SETUP_CALL_KEEP_HOURS} hours is stopped (cancelled), and its results are then kept `
        + `${SETUP_CALL_KEEP_HOURS} hours too. Then its working table is deleted and get_setup_call answers not `
        + 'found.',
    ],
    spendCap: true,
  },
  get_setup_call: {
    text: [
      'Where a setup call (call_setup) is: running, paused, done, failed or cancelled, each step\'s state and '
        + 'run_id, and once it has finished, results: each item, in the order sent, with its status, error and '
        + 'outputs by column (null when it has no value).',
      'A cell where a step failed, found nothing or was kept out by its "Only run if" rule is never given as an '
        + 'output: it reads null, and the item\'s status says so (error, running, condition_not_met, no_result, '
        + 'done, or not_run when nothing was made), with error naming the column that failed and why.',
      `Results come ${SETUP_CALL_MAX_ITEMS} items at a time (limit, up to ${SETUP_CALL_MAX_ITEMS}): next_from is `
        + 'where the next page starts (pass it as results_from), null after the last. create_download_link with '
        + 'setup_call_id (instead of sheet_id) saves every item\'s inputs and outputs as a CSV.',
      `A call left paused for ${SETUP_CALL_KEEP_HOURS} hours is stopped: its status is cancelled and error_message `
        + 'says why.',
    ],
  },
  call_enrichment: {
    text: [
      'get_enrichment lists a tool\'s input names; fields picks the output fields to keep (default every one).',
      'The estimate only reads: it prices the items as run_enrichment\'s estimate prices rows (items that reuse an '
        + 'answer found for the same inputs cost $0) and makes nothing. Started, its spend limit is the estimate\'s '
        + 'high end.',
      'The call is an enrichment run on a working table of its own: get_run_results gives each item\'s status, '
        + 'fields and error, and webhook_id names a run webhook for it. Each output field keeps its name; '
        + 'status_column names the column with each item\'s status (Status, or Status 2 for a tool that answers a '
        + 'status field, as an email check does).',
      `A call left paused for ${SETUP_CALL_KEEP_HOURS} hours is stopped, and its results are then kept `
        + `${SETUP_CALL_KEEP_HOURS} hours too. What it spends shows in Settings as "A call without a sheet".`,
    ],
    spendCap: true,
  },
};
