// get_usage: what runs cost, by column (deleted ones too), day or run, for a
// sheet or the whole account (services/usage.ts; GET /v1/usage is the same read).
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { USAGE_MCP_MAX_ROWS } from '../lib/constants';
import { USAGE_GROUPS, USAGE_RANGES } from '../lib/usage-query';
import { readUsage, usageAsk } from '../services/usage';
import { McpAuthCtx, err, missingScope, ok, registerTool } from './tool-helpers';

export function registerUsageTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 'get_usage', {
    description:
      'What AI, HTTP and enrichment runs cost and how much they ran, from the run records (never the rows), by '
      + 'column, day or run, for one sheet or the whole account. For what is left to spend use get_balances. '
      + 'Each row and the totals give runs, cells (rows run), reused_cells (filled at $0 from an earlier answer), '
      + 'ai_cost_usd (OpenRouter), provider_cost_usd (the user\'s own provider key), enrichment_cost_usd (treg), '
      + 'total_cost_usd and cost_per_cell_usd. Days are UTC and a run counts on the day it started. AI previews '
      + 'and AI helpers (write_formula, write_run_condition) count too, as kind preview or assist. Totals cover '
      + 'the whole range; rows_total says how many rows there are (GET /api/v1/usage with format=csv has every '
      + 'row). Deleted columns and sheets are included (column_deleted, sheet_deleted). Read-only: costs nothing.',
    inputSchema: {
      sheet_id: z.string().optional().describe('One sheet; leave out for the whole account'),
      group_by: z.enum(USAGE_GROUPS).optional().describe('column (default), day or run'),
      range: z.enum(USAGE_RANGES.filter(r => r !== 'custom') as [string, ...string[]]).optional()
        .describe('this_month (default), this_week, last_week or last_month; or pass from and to'),
      from: z.string().optional().describe('First day, YYYY-MM-DD (with to)'),
      to: z.string().optional().describe('Last day, YYYY-MM-DD (with from), included'),
      limit: z.number().int().min(1).max(USAGE_MCP_MAX_ROWS).optional()
        .describe(`Rows, 1-${USAGE_MCP_MAX_ROWS} (default ${USAGE_MCP_MAX_ROWS}): the costliest columns or the `
          + 'newest days or runs'),
    },
  }, async ({ sheet_id, ...rest }: {
    sheet_id?: string; group_by?: string; range?: string; from?: string; to?: string; limit?: number;
  }) => {
    const denied = missingScope(ctx, 'read');
    if (denied) return denied;
    const out = usageAsk(ctx.userId, sheet_id ?? null, { ...rest, limit: rest.limit ?? USAGE_MCP_MAX_ROWS });
    if ('fail' in out) return err(out.message);
    return ok(readUsage(out.ok.scope, out.ok.query));
  });
}
