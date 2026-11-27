// Workspace conveniences that closed real gaps found while dogfooding:
//   get_run's list: runs were fetchable only BY ID, so after a failed or
//                interrupted start the run id was gone with no way back to it.
// (CSV text out of a sheet is read_rows' format csv, tools-read-csv.ts.)
// And get_workspace, where an agent starts: the account, its tables and sheets, the runs going now and the
// spend left, in one small call (services/workspace-overview.ts).
import { McpServer } from '@modelcontextprotocol/server';
import { db } from '../lib/db';
import { listRuns, RUN_LIST_MAX } from '../services/run-list';
import { listTablesWithSheets } from '../services/workspace-read';
import {
  OVERVIEW_RUNS, OVERVIEW_SHEETS, OVERVIEW_TABLES, ROW_COUNT_CAP, workspaceOverview, type Overview,
} from '../services/workspace-overview';
import { tokenSpendFor } from '../services/token-spend';
import { dailyLimitOf } from '../services/enrich-agent-shared';
import { getAccountDefaultModel } from '../lib/ai-model-resolve';
import { runningBuild } from '../lib/cubex-version';
import {
  McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean, type ErrResult, type OkResult,
} from './tool-helpers';
import type { ToolAnswer } from './tool-outputs';

const ownsSheet = (sheetId: string, userId: string): boolean =>
  !!db.prepare('SELECT id FROM sheets WHERE id = ? AND user_id = ? AND trash_id IS NULL').get(sheetId, userId);

// get_run's list (tools-get-run.ts): recent runs, newest first, to find a run_id an agent no longer has.
export function listRunsAnswer(ctx: McpAuthCtx, a: { sheet_id?: string; filter?: 'active' | 'terminal' | 'all';
  limit?: number }): OkResult<ToolAnswer<'get_run'>> | ErrResult {
  // Validate sheet ownership explicitly: without it an unknown/foreign sheet_id would silently return [] and read
  // as "no runs here" rather than "that isn't your sheet".
  if (a.sheet_id !== undefined && !ownsSheet(a.sheet_id, ctx.userId)) return err('Sheet not found');
  const runs = listRuns(ctx.userId, { sheetId: a.sheet_id, filter: a.filter, limit: a.limit });
  return ok({ runs, count: runs.length });
}

const n = (x: number) => x.toLocaleString('en-US');

// What get_workspace left out and which tool reads it, then the usual next steps.
function overviewNote(o: Overview): string {
  const shown = o.tables.reduce((sum, t) => sum + t.sheets.length, 0);
  const runs = o.active_runs.length, setupRuns = o.active_setup_runs.length;
  return [
    ...(o.table_count > o.tables.length || o.sheet_count > shown
      ? [`${n(shown)} of ${n(o.sheet_count)} sheets shown, in ${n(o.tables.length)} of ${n(o.table_count)} `
        + 'tables: get_workspace with all_tables lists them all.'] : []),
    ...(o.active_run_count > runs
      ? [`${n(runs)} of ${n(o.active_run_count)} runs going now shown: get_run (action list) with filter "active" `
        + `lists the newest, up to ${RUN_LIST_MAX} with limit, or one sheet's with sheet_id.`]
      : []),
    ...(o.active_setup_run_count > setupRuns
      ? [`${n(setupRuns)} of ${n(o.active_setup_run_count)} setup runs going now shown: get_sheet lists a sheet's.`]
      : []),
    'get_sheet gives a sheet\'s columns and what fills them; get_account (action balances) reads the live treg and '
      + 'OpenRouter '
      + 'balances.',
  ].join(' ');
}

export function registerOverviewTool(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server,
    'get_workspace',
    {
      description:
        'Start here: where you are, in one small call. Answers cubex_version; access_token, this token\'s name, '
        + 'scopes and spend cap (spend_cap_usd, spent_usd, left_usd; null: no cap); enrichment_daily_limit '
        + '{limit_usd, used_today_usd, remaining_usd}; default_ai_model; table_count and sheet_count; tables, '
        + `the ${OVERVIEW_TABLES} changed most recently, each with its sheet_count and the sheets in it changed `
        + `most recently (${OVERVIEW_SHEETS} at most in all), each sheet with its id, name, columns (how many), `
        + `row_count (counted up to ${n(ROW_COUNT_CAP)}: row_count_at_least true means more) and data_version; `
        + `and the runs and setup runs going now (${OVERVIEW_RUNS} of each at most, runs with processed_rows of `
        + 'total_rows), with their counts. note says what was left out and which tool reads it. Read-only. '
        + 'all_tables: true answers every table and its sheets (ids, names, positions, row counts) instead, to turn '
        + 'a table or sheet name the overview left out into an id; each table also says starred (in the user\'s '
        + 'Favorites) and last_opened_at. '
        + 'Next: get_sheet for a sheet\'s columns, read_rows for its rows.',
      inputSchema: {
        all_tables: lenientBoolean().optional()
          .describe('true: every table with its sheets (row counts too) in place of the overview'),
      },
    },
    async ({ all_tables }) => {
      const denied = missingScope(ctx, 'read');
      if (denied) return denied;
      // A sheet still being counted after a change answers its last count with row_count_updating: true.
      if (all_tables) return ok({ tables: await listTablesWithSheets(ctx.userId) });
      const running = runningBuild();
      const spend = tokenSpendFor(ctx.userId, ctx.tokenId);
      const overview = workspaceOverview(ctx.userId);
      return ok({
        cubex_version: running.version ?? running.build ?? 'unknown',
        access_token: {
          name: ctx.tokenName, scopes: [...ctx.scopes].sort(),
          spend_cap_usd: spend?.spend_cap_usd ?? null, spent_usd: spend?.spent_usd ?? 0,
          left_usd: spend?.left_usd ?? null,
        },
        enrichment_daily_limit: dailyLimitOf(ctx.userId),
        default_ai_model: getAccountDefaultModel(ctx.userId),
        ...overview,
        note: overviewNote(overview),
      });
    },
  );
}
