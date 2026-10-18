// get_run_status: the same summary as GET /v1/{ai,http}-runs/:id, needs only
// 'read'. Optionally waits a few seconds for the run to change, so an agent
// polls less often. control_run is in tools-run-manage.ts.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAiRunSummary, getHttpRunSummary } from '../services/run-status';
import { waitForRunChange } from '../services/run-status-wait';
import { STATUS_WORDS } from '../services/enrich-agent-shared';
import { McpAuthCtx, ok, err, missingScope, registerTool } from './tool-helpers';
import { kindOf } from './tools-run-manage';

export function registerRunStatusTool(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 
    'get_run_status',
    {
      description:
        'Status of an AI, HTTP, enrichment or waterfall run: '
        + 'status (pending/running/paused/completed/failed/cancelled), '
        + 'processed vs total rows, failed_rows and succeeded_rows, and error_message when the run itself failed (or '
        + 'why it paused). "completed" means every row was processed, not that it worked: check failed_rows, then '
        + 'get_run_results for the reasons. AI runs also report concurrency (rows at once) and cost_usd, what the '
        + 'rows so far cost (OpenRouter\'s own '
        + 'figure, web fees included; with rows on the user\'s own provider key (BYOK) only OpenRouter\'s fee, and '
        + 'provider_cost_usd is what that provider billed the key), and with web search the searches that ran '
        + '(searches) and the web_search '
        + 'settings (engine sent, runs_on, mode billed, max_searches_per_row). '
        + 'Enrichment runs (run_type enrichment or http) report cost_usd (what its treg calls cost so far), '
        + 'daily_limit, and enrichment: the tool, max_cost_per_row_usd, spend_limit_usd, pause_reason (spend_limit, '
        + 'daily_limit, balance, no_key, unreachable…: resume with control_run once fixed; a run limit can be raised '
        + 'there), skipped_rows_missing_inputs, providers [{provider, tried, hits, misses, errors, '
        + 'rate_limited (429s), skipped, cost_usd, cooling_down_until}] (what each provider did; a provider that '
        + 'answers 429 three times in a row is left out of the run\'s waterfalls for 5 minutes, then asked again), '
        + 'and for a job that adds '
        + 'rows list {destination_sheet_id, rows_added, '
        + 'adding, waiting_for_fields, waiting_for_room}. A run started with run_if reports run_if and '
        + 'condition_skipped_rows (rows the rule kept out; not in total_rows), counted once the run has started. '
        + 'Waterfall runs (run_type waterfall or http) report cost_usd (treg and AI so far) and waterfall: '
        + 'result_type, spent {treg_usd, ai_usd, total_usd}, run_limit_usd, pause_reason, and steps [{label, kind, '
        + 'on, reached, answered, failed, skipped (no inputs), cost_usd}]. '
        + `${STATUS_WORDS} Poll this after a run start; read the cells with read_rows once completed.`,
      inputSchema: {
        run_type: z.enum(['ai', 'http', 'enrichment', 'waterfall']),
        run_id: z.string(),
        wait_seconds: z.number().int().min(0).max(25).optional(),
      },
    },
    async ({ run_type, run_id, wait_seconds }) => {
      const denied = missingScope(ctx, 'read');
      if (denied) return denied;
      const kind = kindOf(run_type, run_id, ctx.userId);
      if (!kind) return err('Enrichment run not found');
      const run = (wait_seconds ?? 0) > 0
        ? await waitForRunChange(kind, run_id, ctx.userId, wait_seconds, ctx.abortSignal)
        : kind === 'ai' ? getAiRunSummary(run_id, ctx.userId) : getHttpRunSummary(run_id, ctx.userId);
      if (!run) return err('Run not found');
      return ok(run);
    },
  );
}
