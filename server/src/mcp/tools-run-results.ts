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
import { McpServer } from '@modelcontextprotocol/server';
import { ANSWERS_PAGE_MAX, API_V1_DEFAULT_ROWS_PAGE, API_V1_MAX_ROWS_PAGE } from '../lib/api-v1-constants';
import {
  getAiRunResults, getHttpRunResults, RunResultStatusFilter,
} from '../services/run-status';
import { classifyAiError, summarizeErrorClasses } from '../lib/ai-error-classify';
import { classifyHttpError, summarizeHttpErrorClasses } from '../lib/http-error-classify';
import { isEnrichmentRun } from '../services/enrich-agent-control';
import { isWaterfallRun } from '../services/waterfall-agent-control';
import { answersNeedSecrets } from '../services/run-status-enrich';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';
import { GUIDE_POINTER } from './guides/guide';

export function registerRunResultTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server,
    'get_run_results',
    {
      description:
        'Each row\'s outcome in a run: row id, status, error message and an error_class saying what to DO. Use it '
        + 'when cells are blank or wrong, instead of rerunning blind. Rerun only the rows whose error_class says a '
        + 'rerun can work (control_run rerun). include_answers adds each row\'s stored answer (up to '
        + `${ANSWERS_PAGE_MAX} rows a page), to find paths for add_enrichment_field; on an HTTP run that used saved `
        + `keys it needs the 'secrets' scope. Pages by cursor. ${GUIDE_POINTER}`,
      inputSchema: {
        run_type: z.enum(['ai', 'http', 'enrichment', 'waterfall']).describe('The kind of run'),
        run_id: z.string().describe('The run (list_runs lists them)'),
        status_filter: z.enum(['failed', 'completed', 'all']).optional()
          .describe("Default 'failed' ('completed' with include_answers). 'completed' = successful rows only; "
            + "'all' = every row."),
        cursor: z.number().int().min(0).optional()
          .describe('next_cursor from the previous page; omit for the first page'),
        limit: z.number().int().min(1).max(API_V1_MAX_ROWS_PAGE).optional()
          .describe(`Rows per page, default ${API_V1_DEFAULT_ROWS_PAGE}, max ${API_V1_MAX_ROWS_PAGE}`),
        include_answers: lenientBoolean().optional()
          .describe(`HTTP and enrichment runs: each row's stored answer (max ${ANSWERS_PAGE_MAX} rows a page)`),
      },
    },
    async ({ run_type: asked, run_id, status_filter, cursor, limit, include_answers }) => {
      const denied = missingScope(ctx, 'read');
      if (denied) return denied;
      if (asked === 'enrichment' && !isEnrichmentRun(run_id, ctx.userId)) return err('Enrichment run not found');
      if (asked === 'waterfall' && !isWaterfallRun(run_id, ctx.userId)) return err('Waterfall run not found');
      const run_type = asked === 'enrichment' || asked === 'waterfall' ? 'http' : asked;
      if (include_answers && run_type === 'ai') return err('include_answers is for HTTP and enrichment runs.');
      const secrets = include_answers ? answersNeedSecrets(run_id, ctx.userId, ctx.scopes.has('secrets')) : null;
      if (secrets) return err(secrets);

      // Cursor semantics match the v1 rows endpoint: -1 means "from the start".
      // A caller passing 0 legitimately means "after row_index 0", so the
      // absent case must be -1, not 0, or row 0 would be skipped.
      const after = typeof cursor === 'number' ? cursor : -1;
      const pageSize = include_answers ? Math.min(limit ?? ANSWERS_PAGE_MAX, ANSWERS_PAGE_MAX)
        : limit ?? API_V1_DEFAULT_ROWS_PAGE;
      // Answers come from rows that answered: failed rows mostly have none.
      const filter = (status_filter ?? (include_answers ? 'completed' : 'failed')) as RunResultStatusFilter;

      const page = run_type === 'ai'
        ? getAiRunResults(run_id, ctx.userId, after, pageSize, filter)
        : getHttpRunResults(run_id, ctx.userId, after, pageSize, filter, include_answers === true);
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
        run_type: asked,
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
