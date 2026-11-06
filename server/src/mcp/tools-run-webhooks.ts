import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  createRunWebhook, deleteRunWebhook, getRunWebhook, listRunWebhooks, newRunWebhookSecret, runWebhookDeliveries,
  testRunWebhook, updateRunWebhook, type HookFail,
} from '../services/run-hooks';
import { McpAuthCtx, ok, err, missingScope, registerTool, lenientBoolean } from './tool-helpers';

// "Run finished" webhooks (services/run-hooks.ts, the same service as Settings
// and REST /v1/run-webhooks): list_run_webhooks reads them; manage_run_webhook
// adds, changes, deletes, makes a new secret or sends a test, which needs the
// 'run' scope as over REST, since it decides where Cubex sends requests. A run
// started with a webhook's id (webhook_id) tells it when it ends.
const answer = <T>(out: { ok: T } | HookFail, as: (v: T) => object) =>
  ('fail' in out ? err(out.message) : ok(as(out.ok)));

export function registerRunWebhookTools(server: McpServer, ctx: McpAuthCtx): void {
  registerTool(server, 'list_run_webhooks', {
    description:
      'The account\'s run webhooks: URLs Cubex POSTs a signed notice to when a run finishes (event, run_id, kind, '
      + 'sheet_id, status, finished_at). every_run true: told about every AI, HTTP, enrichment and setup run; false: '
      + 'only runs started with its id. Pass that id as webhook_id to run_ai_column, run_http_enrichment, '
      + 'run_enrichment, apply_setup or a control_run rerun to be told when that run ends instead of polling often. '
      + 'Delivery isn\'t guaranteed, so get_run_status stays the source of truth. With webhook_id, also returns '
      + 'that webhook\'s last 50 deliveries (state, response_code, error). Add or change them with '
      + 'manage_run_webhook, or in Settings, Run webhooks.',
    inputSchema: z.object({ webhook_id: z.string().optional() }).strict(),
  }, async ({ webhook_id }) => {
    const denied = missingScope(ctx, 'read');
    if (denied) return denied;
    if (!webhook_id) return ok({ webhooks: listRunWebhooks(ctx.userId) });
    const hook = getRunWebhook(ctx.userId, webhook_id);
    if (!hook) return err('Run webhook not found');
    return ok({ ...hook, deliveries: runWebhookDeliveries(ctx.userId, webhook_id) ?? [] });
  });

  registerTool(server, 'manage_run_webhook', {
    description:
      'Add, change, delete or test a run webhook (see list_run_webhooks). Needs the run scope. action create: '
      + 'url (a public http or https address, no user name or password; private and local addresses are refused) '
      + 'and every_run (default true: told about every run; false: only runs started with its id). It answers '
      + 'with the webhook and its signing secret, the only time the secret is shown: give it to whoever checks '
      + 'the X-Cubex-Signature header. change: webhook_id plus url and/or every_run. delete: webhook_id; its log '
      + 'goes too, and runs that named it just aren\'t told. new_secret: webhook_id; answers a new secret, shown '
      + 'once, and the old one stops signing at once. test: webhook_id; sends a signed "test" notice now and '
      + 'answers how it went (state, response_code, error).',
    inputSchema: z.object({
      action: z.enum(['create', 'change', 'delete', 'new_secret', 'test']),
      webhook_id: z.string().optional().describe('Every action but create: the webhook (list_run_webhooks)'),
      url: z.string().optional().describe('create: required; change: the new URL'),
      every_run: lenientBoolean().optional().describe('true: every run; false: only runs started with its id'),
    }).strict(),
  }, async ({ action, webhook_id, url, every_run }) => {
    const denied = missingScope(ctx, 'run');
    if (denied) return denied;
    if (action === 'create') {
      if (webhook_id !== undefined) return err('create adds a new webhook: leave webhook_id out.');
      return answer(await createRunWebhook(ctx.userId, { url, every_run }), v => v);
    }
    if (!webhook_id) return err(`${action} needs webhook_id (list_run_webhooks lists them).`);
    if (action !== 'change' && (url !== undefined || every_run !== undefined)) {
      return err(`url and every_run are for create and change, not ${action}.`);
    }
    if (action === 'change') {
      if (url === undefined && every_run === undefined) return err('change needs url or every_run.');
      return answer(await updateRunWebhook(ctx.userId, webhook_id, { url, every_run }), webhook => ({ webhook }));
    }
    if (action === 'delete') {
      return deleteRunWebhook(ctx.userId, webhook_id) ? ok({ deleted: true }) : err('Run webhook not found');
    }
    if (action === 'new_secret') return answer(newRunWebhookSecret(ctx.userId, webhook_id), v => v);
    return answer(await testRunWebhook(ctx.userId, webhook_id), delivery => ({ delivery }));
  });
}
