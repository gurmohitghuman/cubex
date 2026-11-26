// The save_only argument of the four run-start tools (services/setup-save-token.ts), described once: the schema
// keeps a short line and the tool's own rule, its guide (mcp/guides) the whole notes.
import { lenientBoolean } from './tool-helpers';

const SAVE_ONLY = 'Store this setup as the column\'s and run nothing: no rows, no cost. Answers saved: true and '
  + 'run_id, the setup\'s record: control_run rerun with it runs the column this way, as do auto-run and its next '
  + 'run. Cells, and which rows read out of date, stay as they are. A new column is made empty. Not with '
  + 'estimate_only or the arguments only a run takes. Default false.';

// What save_only means for each tool, besides the above.
const SAVE_ONLY_MORE = {
  run_ai_column: 'On an existing AI column it replaces the setup. Not with output_columns.',
  run_http_enrichment: 'The only way to change an existing HTTP API column\'s setup: save it, then rerun the column '
    + 'with control_run.',
  run_enrichment: 'With add_to_column: true it replaces an existing column\'s setup. Not for a list job.',
  waterfall_column: 'With add_to_column: true it replaces an existing column\'s setup.',
} as const;
type SavingTool = keyof typeof SAVE_ONLY_MORE;

export const saveOnlySchema = (tool: SavingTool) => lenientBoolean().optional()
  .describe(`true: store this setup as the column's and run nothing (no rows, no cost). ${SAVE_ONLY_MORE[tool]}`);

export const saveOnlyHelp = (tool: SavingTool) => `${SAVE_ONLY} ${SAVE_ONLY_MORE[tool]}`;
