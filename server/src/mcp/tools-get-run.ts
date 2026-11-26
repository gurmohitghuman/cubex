// get_run: every read about runs in one tool (fewer MCP tools, PR A), each action with its old tool's fields and
// answer: status (get_run_status, tools-run-status.ts), results (get_run_results, tools-run-results.ts), list
// (list_runs, tools-workspace.ts) and setup (get_setup_run, tools-setup-runs.ts). Read-only, the read scope.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { ANSWERS_PAGE_MAX, API_V1_DEFAULT_ROWS_PAGE, API_V1_MAX_ROWS_PAGE } from '../lib/api-v1-constants';
import { SETUP_CALL_MAX_ITEMS } from '../lib/constants-setups';
import { MAX_RUN_WAITS_PER_USER } from '../lib/long-poll-holds';
import { RUN_LIST_DEFAULT, RUN_LIST_MAX } from '../services/run-list';
import { McpAuthCtx, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';
import { actionFieldsProblem } from './action-fields';
import { GUIDE_POINTER } from './guides/guide';
import { runStatusAnswer } from './tools-run-status';
import { runResultsAnswer } from './tools-run-results';
import { listRunsAnswer } from './tools-workspace';
import { setupRunRead } from './tools-setup-runs';

const ACTIONS = ['status', 'results', 'list', 'setup'] as const;
type Field = 'run_type' | 'run_id' | 'wait_seconds' | 'status_filter' | 'cursor' | 'limit' | 'include_answers'
  | 'sheet_id' | 'filter' | 'setup_run_id' | 'setup_id' | 'results_from';
const TAKES = {
  status: { needs: ['run_type', 'run_id'], may: ['wait_seconds'] },
  results: { needs: ['run_type', 'run_id'], may: ['status_filter', 'cursor', 'limit', 'include_answers'] },
  list: { may: ['sheet_id', 'filter', 'limit'] },
  setup: { may: ['setup_run_id', 'sheet_id', 'setup_id', 'wait_seconds', 'results_from', 'limit'] },
} as const satisfies Record<typeof ACTIONS[number], { needs?: readonly Field[]; may?: readonly Field[] }>;
// The most rows, runs or items a page holds, by action.
const LIMITS = { results: API_V1_MAX_ROWS_PAGE, list: RUN_LIST_MAX, setup: SETUP_CALL_MAX_ITEMS } as const;

export function registerGetRunTool(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 'get_run', {
    description:
      'Runs, read-only. status: one run\'s state (pending, running, paused, completed, failed, cancelled), row '
      + 'counts, error_message and cost_usd so far; with wait_seconds it answers when the status changes or the time '
      + `is up (with ${MAX_RUN_WAITS_PER_USER} waits of your account open, at once with waited: false). "completed" `
      + 'means every row was processed, not that it worked: check failed_rows, then results. results: each row\'s '
      + 'outcome (row id, status, error message and an error_class saying what to DO), paged by cursor: rerun only '
      + 'the rows a rerun can fix (control_run). list: recent runs, newest first, to FIND a run_id you no longer '
      + 'have. setup: where a setup being used on a sheet (or run_columns, or a call on items) is, step by step. '
      + `Status cells such as "✅ Found", "⏭️ Not found" and "❌ ..." are Cubex's own words, never data. ${GUIDE_POINTER}`,
    inputSchema: {
      action: z.enum(ACTIONS).describe('status, results, list or setup'),
      run_type: z.enum(['ai', 'http', 'enrichment', 'waterfall']).optional()
        .describe('status, results: the kind of run, as what started it says (http also finds enrichment and '
          + 'waterfall runs)'),
      run_id: z.string().optional().describe('status, results: the run_id a run start answered (list lists them)'),
      wait_seconds: z.number().int().min(0).max(25).optional()
        .describe('status: wait up to this many seconds (0-25, default 0) for the status to change (progress alone '
          + 'does not end the wait); setup, with setup_run_id: for it to finish'),
      status_filter: z.enum(['failed', 'completed', 'all']).optional()
        .describe("results: default 'failed' ('completed' with include_answers); 'completed' = successful rows "
          + "only; 'all' = every row"),
      cursor: z.number().int().min(0).optional()
        .describe('results: next_cursor from the previous page; omit for the first page'),
      include_answers: lenientBoolean().optional()
        .describe(`results, HTTP and enrichment runs: each row's stored answer (max ${ANSWERS_PAGE_MAX} rows a page)`),
      sheet_id: z.string().optional()
        .describe('list: one sheet\'s runs (omit for every sheet); setup: the sheet\'s 5 latest setup runs'),
      filter: z.enum(['active', 'terminal', 'all']).optional()
        .describe('list: active (pending, running or paused), terminal (finished) or all (default)'),
      setup_run_id: z.string().optional().describe('setup: one setup run, or a call (apply_setup returned it)'),
      setup_id: z.string().optional().describe('setup, with sheet_id: only this setup\'s runs'),
      results_from: z.number().int().min(0).optional().describe('setup: a call\'s first item of the page (next_from)'),
      limit: z.number().int().min(1).max(API_V1_MAX_ROWS_PAGE).optional()
        .describe(`results: rows a page (default ${API_V1_DEFAULT_ROWS_PAGE}, max ${API_V1_MAX_ROWS_PAGE}); list: `
          + `runs (default ${RUN_LIST_DEFAULT}, max ${RUN_LIST_MAX}); setup: a call's items (max `
          + `${SETUP_CALL_MAX_ITEMS})`),
    },
  }, async ({ action, ...a }) => {
    const denied = missingScope(ctx, 'read');
    if (denied) return denied;
    const problem = actionFieldsProblem<typeof ACTIONS[number], Field>(action, a, TAKES);
    if (problem) return err(problem);
    const most = action === 'status' ? null : LIMITS[action as keyof typeof LIMITS];
    if (most !== null && a.limit !== undefined && a.limit > most) return err(`limit for ${action} is 1 to ${most}.`);
    if (action === 'status') return runStatusAnswer(ctx, { ...a, run_type: a.run_type!, run_id: a.run_id! });
    if (action === 'results') return runResultsAnswer(ctx, { ...a, run_type: a.run_type!, run_id: a.run_id! });
    if (action === 'list') return listRunsAnswer(ctx, a);
    return setupRunRead(ctx, a);
  });
}
