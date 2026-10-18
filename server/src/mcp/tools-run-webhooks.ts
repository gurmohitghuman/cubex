import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getRunWebhook, listRunWebhooks, runWebhookDeliveries } from '../services/run-hooks';
import { McpAuthCtx, ok, err, missingScope, registerTool } from './tool-helpers';

// "Run finished" webhooks (services/run-hooks.ts): read only here. People add
// them in Settings or over REST (POST /api/v1/run-webhooks); a run started with
// one's id (webhook_id) tells it when it ends.
export function registerRunWebhookTools(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'list_run_webhooks', {
    description:
      'The account\'s run webhooks: URLs Cubex POSTs a signed notice to when a run finishes (event, run_id, kind, '
      + 'sheet_id, status, finished_at). every_run true: told about every AI, HTTP, enrichment and setup run; false: '
      + 'only runs started with its id. Pass that id as webhook_id to run_ai_column, run_http_enrichment, '
      + 'run_enrichment, apply_setup or a control_run rerun to be told when that run ends instead of polling often. '
      + 'Delivery isn\'t guaranteed, so get_run_status stays the source of truth. With webhook_id, also returns '
      + 'that webhook\'s last 50 deliveries (state, response_code, error). People add them in Settings, '
      + 'Run webhooks.',
    inputSchema: z.object({ webhook_id: z.string().optional() }).strict(),
  }, async ({ webhook_id }) => {
    const denied = missingScope(ctx, 'read');
    if (denied) return denied;
    if (!webhook_id) return ok({ webhooks: listRunWebhooks(ctx.userId) });
    const hook = getRunWebhook(ctx.userId, webhook_id);
    if (!hook) return err('Run webhook not found');
    return ok({ ...hook, deliveries: runWebhookDeliveries(ctx.userId, webhook_id) ?? [] });
  });
}
