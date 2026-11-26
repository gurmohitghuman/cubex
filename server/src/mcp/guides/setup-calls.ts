// The guides of the tools that call a saved setup on items without a sheet (guide.ts says what a guide holds).
import { SETUP_CALL_KEEP_HOURS } from '../../lib/constants-setups';
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
      `A call left paused for ${SETUP_CALL_KEEP_HOURS} hours is stopped: its status is cancelled and error_message `
        + 'says why.',
    ],
  },
};
