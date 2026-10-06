// Per-row run diagnosis. get_run_status answers "how many failed"; this answers
// "WHY did they fail", which is the difference between a blind (paid) rerun and
// a targeted one.
//
// The gap this closes: a run completes with 200/1000 rows blank. Aggregate
// status can't distinguish rate-limiting from a bad /column reference from
// genuinely-empty upstream data, so the only recovery was re-running everything
// and hoping. Now: read the failures here, then control_run with mode 'errored'
// to retry exactly those rows (see services/ai-rerun-modes.ts).
//
// Same services as GET /v1/{ai,http}-runs/:id/results — no new SQL, no new auth
// path. Split from tools-run-manage.ts for the 200-line guardrail.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { API_V1_DEFAULT_ROWS_PAGE, API_V1_MAX_ROWS_PAGE } from '../lib/api-v1-constants';
import {
  getAiRunResults, getHttpRunResults, RunResultStatusFilter,
} from '../services/run-status';
import { classifyAiError, summarizeErrorClasses } from '../lib/ai-error-classify';
import { classifyHttpError, summarizeHttpErrorClasses } from '../lib/http-error-classify';
import { McpAuthCtx, ok, err, missingScope, registerTool } from './tool-helpers';

export function registerRunResultTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server,
    'get_run_results',
    {
      description:
        'Per-row outcomes for a run — row id, status, error message, and an error_class telling you what to '
        + 'DO about it. AI runs: "retryable" (transient, re-running works), "prompt_content" (your wording caused it, '
        + 'a rerun just bills again), "model_output" (try another model), "configuration" (fix a setting), '
        + '"unknown" (read the message). HTTP runs: "retryable" (rate limit, timeout, 5xx), "not_found" (404/410: '
        + 'the API has nothing for that row, or, on every row, a wrong URL path), "configuration" (URL, auth, '
        + 'headers, {{name}}, JSONPath, blocked address), "response_format" (not JSON), "unknown". '
        + 'error_summary counts each class across the page, with a hint. '
        + 'AI rows also carry cost_usd (what the row cost, web fees included) and, with web search, searches (how many ran) '
        + 'and search_queries ([{query, ran}]; ran:false is a search the per-row limit stopped), to check search quality and spend. '
        + "With a model's own search (runs_on native), searches and their words appear only when the provider reports them. "
        + 'Use this when a run finished but cells are blank or wrong, instead of guessing and re-running blind. '
        + "DEFAULTS TO status_filter 'failed' — the failures are what you want, and returning every successful "
        + "row wastes your context. Then retry only the transient ones with control_run action 'rerun' "
        + "(mode 'errored' for AI, 'missing' for HTTP). Pages by cursor like read_rows.",
      inputSchema: {
        run_type: z.enum(['ai', 'http']),
        run_id: z.string(),
        status_filter: z.enum(['failed', 'completed', 'all']).optional()
          .describe("Default 'failed'. 'completed' = successful rows only; 'all' = every row."),
        cursor: z.number().int().min(0).optional()
          .describe('next_cursor from the previous page; omit for the first page'),
        limit: z.number().int().min(1).max(API_V1_MAX_ROWS_PAGE).optional()
          .describe(`Rows per page, default ${API_V1_DEFAULT_ROWS_PAGE}, max ${API_V1_MAX_ROWS_PAGE}`),
      },
    },
    async ({ run_type, run_id, status_filter, cursor, limit }) => {
      const denied = missingScope(ctx, 'read');
      if (denied) return denied;

      // Cursor semantics match the v1 rows endpoint: -1 means "from the start".
      // A caller passing 0 legitimately means "after row_index 0", so the
      // absent case must be -1, not 0, or row 0 would be skipped.
      const after = typeof cursor === 'number' ? cursor : -1;
      const pageSize = limit ?? API_V1_DEFAULT_ROWS_PAGE;
      const filter = (status_filter ?? 'failed') as RunResultStatusFilter;

      const page = run_type === 'ai'
        ? getAiRunResults(run_id, ctx.userId, after, pageSize, filter)
        : getHttpRunResults(run_id, ctx.userId, after, pageSize, filter);
      // null = unknown run OR a run outside this user's scope. Same generic
      // message either way — never confirm that a run id exists elsewhere.
      if (!page) return err(`${run_type === 'ai' ? 'AI' : 'HTTP'} run not found`);

      // Label each failure with an actionable class, and summarize the page.
      // Classification is derived at READ time from the message rather than
      // stored: the messages are already written and redacted, so a column +
      // migration would add write-path risk and freeze the taxonomy at the
      // moment each row failed — a rule improved later wouldn't apply to
      // history. Re-deriving is cheap (pure regex over one page).
      const classify = run_type === 'ai' ? classifyAiError : classifyHttpError;
      const results = page.results.map(r => (
        r.status === 'failed'
          ? { ...r, error_class: classify(r.error_message) }
          : r
      ));
      const failures = page.results.filter(r => r.status === 'failed').map(r => r.error_message);
      const summarize = run_type === 'ai' ? summarizeErrorClasses : summarizeHttpErrorClasses;

      return ok({
        run_type,
        run_id,
        status_filter: filter,
        results,
        // Only meaningful when the page contains failures; omitted otherwise so
        // a clean page doesn't carry an empty array of nothing.
        ...(failures.length > 0 ? { error_summary: summarize(failures) } : {}),
        next_cursor: page.next_cursor,
      });
    },
  );
}
