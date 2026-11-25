// The save_only argument of the four run-start tools (services/setup-save-token.ts), described once.
import { lenientBoolean } from './tool-helpers';

const SAVE_ONLY = 'Store this setup as the column\'s and run nothing: no rows, no cost. Answers saved: true and '
  + 'run_id, the setup\'s record: control_run rerun with it runs the column this way, as do auto-run and its next '
  + 'run. Cells, and which rows read out of date, stay as they are. A new column is made empty. Not with '
  + 'estimate_only or the arguments only a run takes. Default false.';

export const saveOnlySchema = (more = '') =>
  lenientBoolean().optional().describe(more ? `${SAVE_ONLY} ${more}` : SAVE_ONLY);
