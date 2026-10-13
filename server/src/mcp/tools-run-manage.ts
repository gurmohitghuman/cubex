// Run status + control tools — same services as GET /v1/{ai,http}-runs/:id and
// POST .../{pause,resume,cancel,rerun}. get_run_status needs only 'read';
// control_run needs 'run' (and its rerun action shares the start-rate window,
// since a rerun spends external calls like a fresh start).
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HTTP_MAX_CONCURRENCY, MAX_AI_CONCURRENCY, MAX_ROWS_PER_SHEET } from '../lib/constants';
import { getAiRunSummary, getHttpRunSummary } from '../services/run-status';
import { pauseRun, resumeRun, cancelRun } from '../services/run-lifecycle';
import { rerunAiRunById, rerunHttpRunById } from '../services/run-rerun-by-id';
import { runStartWindow } from '../services/run-shared';
import { tooManyMessage } from '../lib/rate-window';
import { waitForRunChange } from '../services/run-status-wait';
import { isEnrichmentRun, rerunEnrichmentRunById } from '../services/enrich-agent-control';
import { resumeEnrichmentRun } from '../services/enrich-run-status';
import { STATUS_WORDS } from '../services/enrich-agent-shared';
import { McpAuthCtx, ok, err, missingScope, registerTool } from './tool-helpers';

// An enrichment is an HTTP run: run_type 'enrichment' reads and controls the
// same run, and refuses a plain HTTP run so the caller isn't misled.
function kindOf(runType: 'ai' | 'http' | 'enrichment', runId: string, userId: string): 'ai' | 'http' | null {
  if (runType !== 'enrichment') return runType;
  return isEnrichmentRun(runId, userId) ? 'http' : null;
}

export function registerRunManageTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 
    'get_run_status',
    {
      description:
        'Status of an AI, HTTP or enrichment run: status (pending/running/paused/completed/failed/cancelled), '
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
        + `${STATUS_WORDS} Poll this after a run start; read the cells with read_rows once completed.`,
      inputSchema: {
        run_type: z.enum(['ai', 'http', 'enrichment']),
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
        + 'the NEW run_id. '
        + 'ENRICHMENT runs (run_type enrichment): a rerun buys rows from treg again (paid answers it still holds come '
        + 'back cheaper or free), with the column\'s own setup; it needs row_ids or mode: "errored" (❌ rows), '
        + '"empty" (rows not enriched yet, e.g. the rest after a test), "missing" (no result: empty, ⏭️ or ❌), '
        + '"all" (every row again). spend_limit_usd sets the new run\'s limit, or on resume raises a paused run\'s '
        + 'limit (a run its limit paused), and concurrency sets its rows at once.',
      inputSchema: {
        run_type: z.enum(['ai', 'http', 'enrichment']),
        run_id: z.string(),
        action: z.enum(['pause', 'resume', 'cancel', 'rerun']),
        row_ids: z.array(z.string()).min(1).max(MAX_ROWS_PER_SHEET).optional()
          .describe('rerun only: stable row ids to re-process. Wins over mode.'),
        mode: z.enum(['errored', 'empty', 'missing', 'all']).optional()
          .describe(
            'rerun only. AI and enrichment: errored|empty|missing|all (REQUIRED unless row_ids given). '
            + 'HTTP: missing|all.',
          ),
        concurrency: z.number().int().min(1).max(MAX_AI_CONCURRENCY).optional()
          .describe(`AI or enrichment rerun: rows at once (AI 1-${MAX_AI_CONCURRENCY}, enrichment `
            + `1-${HTTP_MAX_CONCURRENCY}). Omit to keep the run's own.`),
        spend_limit_usd: z.number().positive().optional()
          .describe('Enrichment runs only: the run limit for a rerun, or a raised limit on resume.'),
      },
    },
    async ({ run_type: asked, run_id, action, row_ids, mode, concurrency, spend_limit_usd }) => {
      const denied = missingScope(ctx, 'run');
      if (denied) return denied;
      const run_type = kindOf(asked, run_id, ctx.userId);
      if (!run_type) return err('Enrichment run not found');
      const enrichment = run_type === 'http' && isEnrichmentRun(run_id, ctx.userId);
      if (spend_limit_usd !== undefined && !(enrichment && (action === 'resume' || action === 'rerun'))) {
        return err('spend_limit_usd applies to resuming or rerunning an enrichment run only.');
      }
      if (concurrency !== undefined && !(action === 'rerun' && (run_type === 'ai' || enrichment))) {
        return err('concurrency applies to rerunning an AI or enrichment run only.');
      }
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
        });
      }
      if (enrichment && action === 'resume') {
        const resumed = await resumeEnrichmentRun(run_id, ctx.userId, spend_limit_usd);
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
          ? await rerunAiRunById(ctx.userId, run_id, { rowIds: row_ids, mode, concurrency })
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
