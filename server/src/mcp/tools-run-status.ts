// get_run_status: the same summary as GET /v1/{ai,http}-runs/:id, needs only
// 'read'. Optionally waits a few seconds for the run to change, so an agent
// polls less often. control_run is in tools-run-manage.ts.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
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
        'One run\'s state: status (pending, running, paused, completed, failed, cancelled), processed_rows of '
        + 'total_rows, failed_rows, succeeded_rows, error_message and cost_usd so far. Poll it after a run starts '
        + '(wait_seconds waits for a change, so you poll less), then read the cells with read_rows or the reasons '
        + 'with get_run_results. "completed" means every row was processed, not that it worked: check '
        + 'failed_rows. list_runs finds a run_id you no longer have. '
        + 'A run that paused itself says pause_reason and pause_message: token_cap, spend_limit (resume with a '
        + 'higher spend_limit_usd), provider_errors (resume once the provider works), storage (free disk space '
        + 'first), stalled, or web_engine (allow Exa on OpenRouter\'s Server Tools page and resume, or run '
        + 'without the fetch limits). control_run resumes or cancels. '
        + 'waiting: its rows wait for a column another run holds (held_by names that run; a paused holder keeps '
        + 'them waiting: resume or cancel it with control_run). Runs waiting on each other in a ring fail, with '
        + 'words that name the columns. '
        + 'AI runs add concurrency, cost_usd (OpenRouter\'s figure, web fees included; on your own provider key '
        + 'only OpenRouter\'s fee, and provider_cost_usd is what the provider billed), rows_paid_with, searches, '
        + 'web_search and, with a spend limit, spend_limit_usd and resume_least_usd (the least spend_limit_usd a '
        + 'resume takes; it grows as the run spends). '
        + 'Enrichment runs (run_type enrichment or http) add daily_limit, enrichment (the tool, its limits, '
        + 'pause_reason: spend_limit, daily_limit, balance, no_key, unreachable…, skipped_rows_missing_inputs), '
        + 'providers (what each did; one that answers 429 three times in a row sits out 5 minutes) and, for a tool '
        + 'that adds rows, list (destination_sheet_id, rows_added, adding, waiting_for_fields, waiting_for_room). '
        + 'A run_if run adds run_if and condition_skipped_rows (not in total_rows). Waterfall runs (run_type '
        + 'waterfall or http) add waterfall: result_type, spent, run_limit_usd, pause_reason and per step reached, '
        + `answered, failed, skipped and cost_usd. ${STATUS_WORDS}`,
      inputSchema: {
        run_type: z.enum(['ai', 'http', 'enrichment', 'waterfall'])
          .describe('The kind of run: what started it says (http also finds enrichment and waterfall runs)'),
        run_id: z.string().describe('The run_id a run start answered (list_runs lists them)'),
        wait_seconds: z.number().int().min(0).max(25).optional()
          .describe('Wait up to this many seconds (0-25, default 0) for the run to change before answering'),
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
