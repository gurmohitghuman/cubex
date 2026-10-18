// Run control: control_run, the same services as POST
// /v1/{ai,http}-runs/:id/{pause,resume,cancel,rerun} and, for cancel_all, POST
// /v1/sheets/:id/runs/stop. It needs 'run' (and its rerun action shares the
// start-rate window, since a rerun spends external calls like a fresh start).
// get_run_status lives in tools-run-status.ts.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HTTP_MAX_CONCURRENCY, MAX_AI_CONCURRENCY, MAX_FIRST_ROWS, MAX_ROWS_PER_SHEET } from '../lib/constants';
import { getAiRunSummary, getHttpRunSummary } from '../services/run-status';
import { stopSheetRuns } from '../services/sheet-runs-stop';
import { pauseRun, resumeRun, cancelRun } from '../services/run-lifecycle';
import { rerunAiRunById, rerunHttpRunById } from '../services/run-rerun-by-id';
import { runStartWindow } from '../services/run-shared';
import { tooManyMessage } from '../lib/rate-window';
import { isEnrichmentRun, rerunEnrichmentRunById } from '../services/enrich-agent-control';
import { attachRunWebhook, webhookIdProblem } from '../services/run-hooks-attach';
import { resumeEnrichmentRun } from '../services/enrich-run-status';
import { McpAuthCtx, ok, err, missingScope, registerTool } from './tool-helpers';

// An enrichment is an HTTP run: run_type 'enrichment' reads and controls the
// same run, and refuses a plain HTTP run so the caller isn't misled.
export function kindOf(runType: 'ai' | 'http' | 'enrichment', runId: string, userId: string): 'ai' | 'http' | null {
  if (runType !== 'enrichment') return runType;
  return isEnrichmentRun(runId, userId) ? 'http' : null;
}

// cancel_all: every run and setup on a sheet, at once (services/sheet-runs-stop.ts).
async function cancelAll(ctx: McpAuthCtx, sheetId: string | undefined, otherArgs: boolean) {
  if (!sheetId) return err('cancel_all needs sheet_id: the sheet whose runs to stop.');
  if (otherArgs) return err('cancel_all takes only sheet_id: it stops every run on the sheet, whatever its type.');
  const out = await stopSheetRuns(ctx.userId, sheetId);
  return 'fail' in out ? err(out.message) : ok(out.ok);
}

export function registerRunManageTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 
    'control_run',
    {
      description:
        'Pause, resume, or cancel an active run, or rerun a finished one. rerun starts a NEW run reusing the column\'s '
        + 'latest config and COSTS MONEY AGAIN — one AI call per targeted row. For an AI rerun you MUST pass either '
        + 'row_ids or mode (there is no default): mode "errored" re-runs only ❌ rows (the usual retry), "empty" only '
        + 'blank rows, "missing" empty+errored+unfinished, "all" EVERY row in the sheet. For HTTP, mode is "missing" '
        + 'or "all" (default all). Check get_run_status or get_run_results first so you know how many rows you are '
        + 'about to re-bill. A structured (output_columns) run reruns whole: one call per targeted row refills all its '
        + 'typed columns (and its (Data) column), and the modes read its "(Status)" column (❌, blank, ⏳). An AI '
        + 'rerun takes concurrency to change how many rows run at once (default: the run it repeats); rows that '
        + 'failed with error_class "concurrency" (OpenRouter\'s in-flight credit budget) need a lower one. Returns '
        + 'the NEW run_id. first_rows (AI and HTTP) reruns only among the sheet\'s top rows, a test before a big '
        + 'run: every one of them, or those mode picks. '
        + 'ENRICHMENT runs (run_type enrichment): a rerun buys rows from treg again (paid answers it still holds come '
        + 'back cheaper or free), with the column\'s own setup; it needs row_ids or mode: "errored" (❌ rows), '
        + '"empty" (rows not enriched yet, e.g. the rest after a test), "missing" (no result: empty, ⏭️ or ❌), '
        + '"all" (every row again). spend_limit_usd sets the new run\'s limit, or on resume raises a paused run\'s '
        + 'limit (a run its limit paused). concurrency sets its rows at once on a rerun or a resume, and the '
        + 'column keeps it for later reruns and auto-run; lower it when a provider answers 429. '
        + 'STOP A WHOLE SHEET: action cancel_all with sheet_id (no run_type or run_id) stops every active run on '
        + 'it at once: AI, HTTP and enrichment runs and the setups being used on it (get_sheet lists them in '
        + 'active_runs and active_setup_runs). It returns stopped_runs, stopped_setup_runs and a message. It '
        + 'turns no auto-run off: a column whose auto-run batch it stopped pauses, as cancelling that one run '
        + 'does (auto_run_paused; resume it to go on), and auto_run_on lists the columns where new rows still '
        + 'start runs (set_auto_run with paused true and no column pauses them all). Calls already sent finish '
        + 'and are billed; free clean and formula fills finish too (still_filling).',
      inputSchema: {
        run_type: z.enum(['ai', 'http', 'enrichment']).optional()
          .describe('Every action but cancel_all.'),
        run_id: z.string().optional().describe('Every action but cancel_all.'),
        action: z.enum(['pause', 'resume', 'cancel', 'rerun', 'cancel_all']),
        sheet_id: z.string().optional().describe('cancel_all only: the sheet whose runs to stop.'),
        row_ids: z.array(z.string()).min(1).max(MAX_ROWS_PER_SHEET).optional()
          .describe('rerun only: stable row ids to re-process. Wins over mode.'),
        mode: z.enum(['errored', 'empty', 'missing', 'all']).optional()
          .describe(
            'rerun only. AI and enrichment: errored|empty|missing|all (REQUIRED unless row_ids given). '
            + 'HTTP: missing|all.',
          ),
        concurrency: z.number().int().min(1).max(MAX_AI_CONCURRENCY).optional()
          .describe(`AI rerun, or enrichment rerun or resume: rows at once (AI 1-${MAX_AI_CONCURRENCY}, `
            + `enrichment 1-${HTTP_MAX_CONCURRENCY}). Omit to keep the run's own.`),
        spend_limit_usd: z.number().positive().optional()
          .describe('Enrichment runs only: the run limit for a rerun, or a raised limit on resume.'),
        first_rows: z.number().int().min(1).max(MAX_FIRST_ROWS).optional()
          .describe(`AI or HTTP rerun only: only among the sheet's first rows (1-${MAX_FIRST_ROWS}).`),
        webhook_id: z.string().optional()
          .describe('rerun only: a run webhook (list_run_webhooks) to notify when the new run finishes.'),
      },
    },
    async ({
      run_type: asked, run_id, action, sheet_id, row_ids, mode, concurrency, spend_limit_usd, first_rows, webhook_id,
    }) => {
      const denied = missingScope(ctx, 'run');
      if (denied) return denied;
      if (action === 'cancel_all') {
        const others = [asked, run_id, row_ids, mode, concurrency, spend_limit_usd, first_rows, webhook_id];
        return cancelAll(ctx, sheet_id, others.some(v => v !== undefined));
      }
      if (sheet_id !== undefined) return err('sheet_id goes with action cancel_all only.');
      if (!asked || !run_id) {
        return err('Pass run_type and run_id, or action cancel_all with sheet_id to stop every run on a sheet.');
      }
      const run_type = kindOf(asked, run_id, ctx.userId);
      if (!run_type) return err('Enrichment run not found');
      const enrichment = run_type === 'http' && isEnrichmentRun(run_id, ctx.userId);
      if (spend_limit_usd !== undefined && !(enrichment && (action === 'resume' || action === 'rerun'))) {
        return err('spend_limit_usd applies to resuming or rerunning an enrichment run only.');
      }
      if (concurrency !== undefined
        && !((action === 'rerun' && (run_type === 'ai' || enrichment)) || (action === 'resume' && enrichment))) {
        return err('concurrency applies only to rerunning an AI or enrichment run, or resuming an enrichment run.');
      }
      if (first_rows !== undefined && (action !== 'rerun' || enrichment)) {
        return err('first_rows applies only to rerunning an AI or HTTP API run.');
      }
      if (first_rows !== undefined && row_ids) return err('Pass first_rows or row_ids, not both.');
      if (webhook_id !== undefined && action !== 'rerun') return err('webhook_id goes with action rerun only.');
      const hookProblem = webhookIdProblem(ctx.userId, webhook_id);
      if (hookProblem) return err(hookProblem);
      const hooked = (table: 'ai_runs' | 'http_runs', id: string) => {
        if (webhook_id) attachRunWebhook(table, id, ctx.userId, webhook_id);
        return webhook_id ? { webhook_id } : {};
      };
      if (enrichment && action === 'rerun') {
        if (!row_ids && !mode) {
          return err("An enrichment rerun needs row_ids or mode: 'errored', 'empty' (not enriched yet), "
            + "'missing' (no result) or 'all' (buys every row again).");
        }
        const slot = runStartWindow(ctx.tokenId);
        if (!slot.allowed) return err(tooManyMessage('run starts', slot));
        const out = await rerunEnrichmentRunById(
          ctx.userId, run_id, { rowIds: row_ids, mode, spendLimitUsd: spend_limit_usd, concurrency },
        );
        if ('fail' in out) return err(out.message);
        return ok({
          run_id: out.ok.runId, run_type: 'enrichment', rows_in_scope: out.ok.rowsInScope,
          ...(out.ok.destinationAutoRun ? { destination_auto_run: out.ok.destinationAutoRun } : {}),
          ...hooked('http_runs', out.ok.runId),
        });
      }
      if (enrichment && action === 'resume') {
        const resumed = await resumeEnrichmentRun(run_id, ctx.userId, spend_limit_usd, concurrency);
        if ('fail' in resumed) return err(resumed.message);
        return ok(getHttpRunSummary(run_id, ctx.userId));
      }

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
        if (run_type === 'ai' && !row_ids && !mode && !first_rows) {
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
          ? await rerunAiRunById(ctx.userId, run_id, {
            rowIds: row_ids, mode: mode ?? (first_rows ? 'all' : undefined), concurrency, firstRows: first_rows,
          })
          : await rerunHttpRunById(ctx.userId, run_id, {
            rowIds: row_ids, mode: mode as 'missing' | 'all' | undefined, hasSecretsScope: hasSecrets,
            firstRows: first_rows,
          });
        if ('fail' in result) return err(result.message);
        return ok({
          run_id: result.ok.runId, target_rows: result.ok.targetCount,
          ...hooked(run_type === 'ai' ? 'ai_runs' : 'http_runs', result.ok.runId),
        });
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
