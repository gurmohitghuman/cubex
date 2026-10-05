// Run status + control tools — same services as GET /v1/{ai,http}-runs/:id and
// POST .../{pause,resume,cancel,rerun}. get_run_status needs only 'read';
// control_run needs 'run' (and its rerun action shares the start-rate window,
// since a rerun spends external calls like a fresh start).
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MAX_ROWS_PER_SHEET } from '../lib/constants';
import { getAiRunSummary, getHttpRunSummary } from '../services/run-status';
import { pauseRun, resumeRun, cancelRun } from '../services/run-lifecycle';
import { rerunAiRunById, rerunHttpRunById } from '../services/run-rerun-by-id';
import { runStartWindow } from '../services/run-shared';
import { tooManyMessage } from '../lib/rate-window';
import { waitForRunChange } from '../services/run-status-wait';
import { McpAuthCtx, ok, err, missingScope, registerTool } from './tool-helpers';

export function registerRunManageTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 
    'get_run_status',
    {
      description:
        'Status of an AI or HTTP enrichment run: status (pending/running/paused/completed/failed/cancelled), processed vs total rows, failed_rows and succeeded_rows, and error_message when the run itself failed. "completed" means every row was processed, not that it worked: check failed_rows, then get_run_results for the reasons. Poll this after run_ai_column / run_http_enrichment; read the enriched cells with read_rows once completed.',
      inputSchema: {
        run_type: z.enum(['ai', 'http']),
        run_id: z.string(),
        wait_seconds: z.number().int().min(0).max(25).optional(),
      },
    },
    async ({ run_type, run_id, wait_seconds }) => {
      const denied = missingScope(ctx, 'read');
      if (denied) return denied;
      const run = (wait_seconds ?? 0) > 0
        ? await waitForRunChange(run_type, run_id, ctx.userId, wait_seconds, ctx.abortSignal)
        : run_type === 'ai' ? getAiRunSummary(run_id, ctx.userId) : getHttpRunSummary(run_id, ctx.userId);
      if (!run) return err('Run not found');
      return ok(run);
    },
  );

  registerTool(server, 
    'control_run',
    {
      description:
        'Pause, resume, or cancel an active run, or rerun a finished one. rerun starts a NEW run reusing the column\'s latest config and COSTS MONEY AGAIN — one AI call per targeted row. For an AI rerun you MUST pass either row_ids or mode (there is no default): mode "errored" re-runs only ❌ rows (the usual retry), "empty" only blank rows, "missing" empty+errored+unfinished, "all" EVERY row in the sheet. For HTTP, mode is "missing" or "all" (default all). Check get_run_status or get_run_results first so you know how many rows you are about to re-bill. Structured (output_columns) runs can\'t be rerun yet: to retry their rows, call run_ai_column with target_row_ids and new output column names, or delete the output columns and run again. Returns the NEW run_id.',
      inputSchema: {
        run_type: z.enum(['ai', 'http']),
        run_id: z.string(),
        action: z.enum(['pause', 'resume', 'cancel', 'rerun']),
        row_ids: z.array(z.string()).min(1).max(MAX_ROWS_PER_SHEET).optional()
          .describe('rerun only: stable row ids to re-process. Wins over mode.'),
        mode: z.enum(['errored', 'empty', 'missing', 'all']).optional()
          .describe('rerun only. AI: errored|empty|missing|all (REQUIRED unless row_ids given). HTTP: missing|all.'),
      },
    },
    async ({ run_type, run_id, action, row_ids, mode }) => {
      const denied = missingScope(ctx, 'run');
      if (denied) return denied;

      // Whether THIS token may resolve saved api_keys — gates resuming/rerunning
      // a key-referencing HTTP run (a 'run'-only token must be refused, same as
      // the /api/v1 surface). See http-secrets-scan.ts.
      const hasSecrets = ctx.scopes.has('secrets');

      if (action === 'rerun') {
        // A rerun re-bills every targeted row. The old AI default ("empty or
        // errored") silently meant EVERY row on a fresh/mostly-empty column —
        // a 10-row retry once became a 9,675-row run. So an AI rerun must say
        // explicitly what it targets; there is no implicit default here.
        // (The UI route and /api/v1 keep 'missing' for back-compat.)
        if (run_type === 'ai' && !row_ids && !mode) {
          return err(
            "An AI rerun needs an explicit target: pass mode ('errored' to retry failed rows, "
            + "'empty' for blank cells, 'missing' for both plus unfinished, 'all' to re-run and "
            + 're-bill EVERY row) or row_ids for a specific subset.',
          );
        }
        if (run_type === 'http' && mode && mode !== 'missing' && mode !== 'all') {
          return err(`An HTTP rerun supports mode 'missing' or 'all' (got '${mode}').`);
        }
        const slot = runStartWindow(ctx.tokenId);
        if (!slot.allowed) return err(tooManyMessage('run starts', slot));
        const result = run_type === 'ai'
          ? await rerunAiRunById(ctx.userId, run_id, { rowIds: row_ids, mode })
          : await rerunHttpRunById(ctx.userId, run_id, {
            rowIds: row_ids, mode: mode as 'missing' | 'all' | undefined, hasSecretsScope: hasSecrets,
          });
        if ('fail' in result) return err(result.message);
        return ok({ run_id: result.ok.runId, target_rows: result.ok.targetCount });
      }

      const result = action === 'pause' ? pauseRun(run_type, run_id, ctx.userId)
        : action === 'resume' ? await resumeRun(run_type, run_id, ctx.userId, hasSecrets)
        : await cancelRun(run_type, run_id, ctx.userId);
      if ('fail' in result) return err(result.message);
      const summary = run_type === 'ai'
        ? getAiRunSummary(run_id, ctx.userId)
        : getHttpRunSummary(run_id, ctx.userId);
      return ok(summary);
    },
  );
}
