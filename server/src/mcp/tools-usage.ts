// get_usage: what runs cost, by column (deleted ones too), day or run, for a
// sheet or the whole account (services/usage.ts; GET /v1/usage is the same read).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { USAGE_MCP_MAX_ROWS } from '../lib/constants';
import { USAGE_GROUPS, USAGE_RANGES } from '../lib/usage-query';
import { readUsage, usageAsk } from '../services/usage';
import { McpAuthCtx, err, missingScope, ok, registerTool } from './tool-helpers';

export function registerUsageTools(server: McpServer, ctx: McpAuthCtx) {
  registerTool(server, 'get_usage', {
    description:
      'What AI, HTTP and enrichment runs cost and how much they ran, read from the run records (never the rows): '
      + 'group_by column (default; deleted columns too, column_deleted true), day or run, for one sheet (sheet_id) '
      + 'or the whole account. Each row and the totals have runs, cells (rows run), reused_cells (filled from an '
      + 'earlier found answer at $0), ai_cost_usd (what OpenRouter charged), provider_cost_usd (billed to the '
      + 'user\'s own provider key), enrichment_cost_usd (treg), total_cost_usd and cost_per_cell_usd. range: '
      + 'this_week, this_month (default), last_week or last_month, or from and to (YYYY-MM-DD, both included). '
      + 'Days are UTC and a run counts on the day it started. AI previews (the app\'s tries, preview_rows) and AI '
      + 'helpers (write_formula, write_run_condition, the app\'s HTTP request writer) count too, as kind preview '
      + 'or assist: one record for each use, with no run behind it. '
      + `At most limit rows (default and most ${USAGE_MCP_MAX_ROWS}, the costliest columns or the newest days or `
      + 'runs); totals always cover the whole range and rows_total says how many there are (narrow the range, or '
      + 'GET /api/v1/usage with format=csv has every row). Rows of a deleted sheet have sheet_deleted true. '
      + 'Read-only: costs nothing.',
    inputSchema: {
      sheet_id: z.string().optional().describe('One sheet; leave out for the whole account'),
      group_by: z.enum(USAGE_GROUPS).optional(),
      range: z.enum(USAGE_RANGES.filter(r => r !== 'custom') as [string, ...string[]]).optional(),
      from: z.string().optional().describe('First day, YYYY-MM-DD (with to)'),
      to: z.string().optional().describe('Last day, YYYY-MM-DD (with from)'),
      limit: z.number().int().min(1).max(USAGE_MCP_MAX_ROWS).optional(),
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
