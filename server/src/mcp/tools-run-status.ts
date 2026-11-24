// get_run_status: the same summary as GET /v1/{ai,http}-runs/:id, needs only
// 'read'. Optionally waits up to 25 seconds for the status to change (progress
// alone doesn't end the wait), so an agent polls less often; with the account's
// wait slots all taken it answers at once, with waited: false and
// retry_after_seconds. control_run is in tools-run-manage.ts.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { getAiRunSummary, getHttpRunSummary } from '../services/run-status';
import { waitForRunChange } from '../services/run-status-wait';
import { MAX_RUN_WAITS_PER_USER } from '../lib/long-poll-holds';
import { STATUS_WORDS } from '../services/enrich-agent-shared';
import { McpAuthCtx, ok, err, missingScope, registerTool } from './tool-helpers';
import { kindOf } from './tools-run-manage';

export function registerRunStatusTool(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 
    'get_run_status',
    {
      description:
        'One run\'s state: status (pending, running, paused, completed, failed, cancelled), row counts, '
        + 'error_message and cost_usd so far. Poll it with wait_seconds: it answers when the status changes or the '
        + `time is up (with ${MAX_RUN_WAITS_PER_USER} waits of your account open, at once with waited: false). `
        + '"completed" means every row was processed, not that it worked: check failed_rows, then get_run_results. '
        + 'list_runs finds a lost run_id. '
        + 'pause_reason says why a run paused itself: token_cap, spend_limit (resume with a spend_limit_usd of at '
        + 'least resume_least_usd), provider_errors, storage (free disk space first), stalled, web_engine (allow Exa '
        + 'on OpenRouter\'s Server Tools page), or for enrichments daily_limit, balance, no_key or unreachable. '
        + 'control_run resumes or cancels. waiting: its rows wait for a column another run (held_by) holds. On your '
        + 'own provider key cost_usd is only OpenRouter\'s fee; provider_cost_usd is the provider\'s bill. '
        + `condition_skipped_rows (run_if) are not in total_rows. ${STATUS_WORDS}`,
      inputSchema: {
        run_type: z.enum(['ai', 'http', 'enrichment', 'waterfall'])
          .describe('The kind of run: what started it says (http also finds enrichment and waterfall runs)'),
        run_id: z.string().describe('The run_id a run start answered (list_runs lists them)'),
        wait_seconds: z.number().int().min(0).max(25).optional()
          .describe('Wait up to this many seconds (0-25, default 0) for the status to change before answering; '
            + 'progress alone does not end the wait'),
      },
    },
    async ({ run_type, run_id, wait_seconds }) => {
      const denied = missingScope(ctx, 'read');
      if (denied) return denied;
      const kind = kindOf(run_type, run_id, ctx.userId);
      if (!kind) return err('Enrichment run not found');
      const { run, noSlot } = (wait_seconds ?? 0) > 0
        ? await waitForRunChange(kind, run_id, ctx.userId, wait_seconds, ctx.abortSignal, { statusOnly: true })
        : { run: kind === 'ai' ? getAiRunSummary(run_id, ctx.userId) : getHttpRunSummary(run_id, ctx.userId) };
      if (!run) return err('Run not found');
      return ok(noSlot ? { ...run, waited: false, retry_after_seconds: noSlot.retryAfterSec } : run);
    },
  );
}
