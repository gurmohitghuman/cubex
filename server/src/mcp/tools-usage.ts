// get_usage: what runs cost, by column (deleted ones too), day or run, for a
// sheet or the whole account (services/usage.ts; GET /v1/usage is the same read).
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { USAGE_MCP_MAX_ROWS } from '../lib/constants';
import { USAGE_GROUPS, USAGE_RANGES } from '../lib/usage-query';
import { readUsage, usageAsk } from '../services/usage';
import { McpAuthCtx, err, missingScope, ok, registerTool } from './tool-helpers';
import { GUIDE_POINTER } from './guides/guide';

export function registerUsageTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 'get_usage', {
    description:
      'What AI, HTTP and enrichment runs cost and how much they ran, from the run records (never the rows), by '
      + 'column, day or run, for one sheet or the whole account. For what is left to spend use get_balances. '
      + `Read-only: costs nothing. ${GUIDE_POINTER}`,
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
