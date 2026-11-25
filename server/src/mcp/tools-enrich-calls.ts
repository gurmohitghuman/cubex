import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { ENRICH_CALL_MAX_ITEMS } from '../lib/constants-setups';
import { RUN_SPEND_LIMIT_MAX_USD } from '../lib/constants';
import { callEnrichment } from '../services/enrich-call';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';
import { capToolNote } from '../lib/token-spend';

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

// One enrichment tool called on items without a sheet (services/enrich-call.ts): call_enrichment. The call is an
// enrichment run: get_run_status and get_run_results answer for it.
export function registerEnrichCallTools(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'call_enrichment', {
    description:
      `Run one enrichment tool (search_enrichments) on 1-${ENRICH_CALL_MAX_ITEMS} items without a sheet, each keyed `
      + 'by its input names. COSTS MONEY; estimate_only defaults to true. Refused before it starts, never halfway, '
      + 'when it could pass max_cost_usd, today\'s daily limit, the treg balance or the token\'s cap. Returns a '
      + 'run_id: get_run_status, then get_run_results with status_filter all (row_index is the item).'
      + capToolNote(ctx.spend ?? null, true),
    inputSchema: z.object({
      tool_id: z.string().max(200).describe('The tool (search_enrichments)'),
      items: z.array(z.record(z.string(), cell)).min(1).max(ENRICH_CALL_MAX_ITEMS)
        .describe('[{ "<tool input>": value }]'),
      fields: z.array(z.string()).optional().describe('Output fields to keep (default all)'),
      estimate_only: lenientBoolean().optional().describe('Default true: price it, start nothing'),
      max_cost_usd: z.number().positive().max(RUN_SPEND_LIMIT_MAX_USD).optional()
        .describe('Refuse to start when it could cost more, in dollars'),
      allow_unpriced: lenientBoolean().optional().describe('Run a tool with no known price'),
      webhook_id: z.string().optional().describe('A run webhook to notify when it finishes'),
    }).strict(),
  }, async ({ tool_id, items, fields, estimate_only, max_cost_usd, allow_unpriced, webhook_id }) => {
    const denied = missingScope(ctx, 'run');
    if (denied) return denied;
    const out = await callEnrichment(ctx, {
      toolId: tool_id, items, fields, estimateOnly: estimate_only !== false, maxCostUsd: max_cost_usd ?? null,
      allowUnpriced: !!allow_unpriced, webhookId: webhook_id ?? null,
    });
    if ('fail' in out) return err(out.message + (out.estimate ? ` Estimate: ${JSON.stringify(out.estimate)}` : ''));
    return ok(out.ok);
  });
}
