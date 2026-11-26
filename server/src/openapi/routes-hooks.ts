// /api/v1 routes: a sheet's incoming webhook (api-v1-sheet-webhook.ts) and "run finished" webhooks
// (run-webhooks-routes.ts, mounted by api-v1.ts at /run-webhooks).
import { z } from 'zod';
import { op, type RouteDoc } from './route-doc';

const url = z.string().describe('A public http(s) address. Private and local addresses are refused.');
const everyRun = z.boolean().describe('true: told when any run finishes. false: only runs that name it.');

const writeForUrl = 'The url is in the answer only for a key with write, and only until the first event arrives.';

export const hookRoutes = (): RouteDoc[] => [
  op({
    method: 'get', path: '/sheets/{id}/webhook', operationId: 'getSheetWebhook', tag: 'webhook', scope: 'read',
    summary: "A sheet's incoming webhook: on or off, events received, the last error and its fields. null if none.",
    description: writeForUrl,
  }),
  op({
    method: 'post', path: '/sheets/{id}/webhook', operationId: 'createSheetWebhook', tag: 'webhook', scope: 'write',
    summary: 'Give a sheet its incoming webhook (one per sheet) and a column that marks the rows it adds.',
    description: writeForUrl, responses: { 201: 'The webhook, with its url.' },
  }),
  op({
    method: 'patch', path: '/sheets/{id}/webhook', operationId: 'setSheetWebhookEnabled', tag: 'webhook',
    scope: 'write', summary: 'Turn the webhook on or off. While off, events get 404 and add nothing.',
    body: z.object({ enabled: z.boolean().describe('true: on. false: off.') }),
  }),
  op({
    method: 'post', path: '/sheets/{id}/webhook/rotate', operationId: 'rotateSheetWebhook', tag: 'webhook',
    scope: 'write', summary: 'Make a new URL, in the answer. The old one stops at once.',
  }),
  op({
    method: 'post', path: '/sheets/{id}/webhook/token', operationId: 'newSheetWebhookToken', tag: 'webhook',
    scope: 'write', summary: 'Make senders send a token (Authorization: Bearer <token>). Any old token stops.',
    description: 'The token is in the answer, the only time it is shown. An event without it gets 404.',
  }),
  op({
    method: 'delete', path: '/sheets/{id}/webhook/token', operationId: 'removeSheetWebhookToken', tag: 'webhook',
    scope: 'write', summary: 'Senders no longer need a token: anyone with the URL can add rows again.',
  }),
  op({
    method: 'put', path: '/sheets/{id}/webhook/auto-delete', operationId: 'setSheetWebhookAutoDelete',
    tag: 'webhook', scope: 'write',
    summary: 'Keep the newest rows; older ones the webhook added are deleted once their auto-run columns ran.',
    description: 'What a call leaves out stays; null clears success_column or copy_to_sheet_id. Rows can be copied '
      + 'to another sheet first. Deleted rows do not go to the trash.',
    body: z.object({
      mode: z.enum(['actions_finish', 'rules']).optional()
        .describe('actions_finish (default): rows leave once every auto-run column has run on them. rules: once '
          + 'they pass where.'),
      where: z.array(z.record(z.string(), z.unknown())).nullable().optional()
        .describe('mode rules: the rules a row must pass, in the where language of read_rows. null clears them.'),
      keep_rows: z.number().int().optional().describe('The newest rows that always stay, 0 to 100000. Default 100.'),
      success_column: z.string().nullable().optional().describe('A row leaves only once this column has a result.'),
      copy_to_sheet_id: z.string().nullable().optional().describe('Rows are copied to this sheet before they leave.'),
    }),
  }),
  op({
    method: 'delete', path: '/sheets/{id}/webhook/auto-delete', operationId: 'removeSheetWebhookAutoDelete',
    tag: 'webhook', scope: 'write', summary: 'Turn auto-delete off. Rows already gone stay gone.',
  }),
  op({
    method: 'delete', path: '/sheets/{id}/webhook', operationId: 'deleteSheetWebhook', tag: 'webhook',
    scope: 'write', summary: 'Delete the webhook and its kept events. Its columns and rows stay.',
  }),
  op({
    method: 'post', path: '/sheets/{id}/webhook/fields', operationId: 'addSheetWebhookField', tag: 'webhook',
    scope: 'write', summary: 'Fill a new column from each event: the value at json_path, as text or JSON.',
    body: z.object({
      json_path: z.string().describe('Where the value is in each event, like $.email or $.plan.name.'),
      column: z.string().describe("The new column's name."),
      as: z.enum(['text', 'json']).optional().describe('text (default), or the value as JSON.'),
    }),
    responses: { 201: 'The webhook with its fields.' },
  }),
  op({
    method: 'delete', path: '/sheets/{id}/webhook/fields/{fieldId}', operationId: 'removeSheetWebhookField',
    tag: 'webhook', scope: 'write', summary: 'Stop filling a field. Its column and values stay.',
  }),
  op({
    method: 'get', path: '/run-webhooks', operationId: 'listRunWebhooks', tag: 'hooks', scope: 'read',
    summary: 'List the run webhooks with their last delivery. Never the secret.',
  }),
  op({
    method: 'post', path: '/run-webhooks', operationId: 'createRunWebhook', tag: 'hooks', scope: 'run',
    summary: 'Add a URL that Cubex tells, with a signed POST, when a run finishes.',
    body: z.object({ url, every_run: everyRun.optional().describe(`${everyRun.description} Default true.`) }),
    responses: { 201: 'The webhook and its secret. This is the only time the secret is shown.' },
  }),
  op({
    method: 'get', path: '/run-webhooks/{id}', operationId: 'getRunWebhook', tag: 'hooks', scope: 'read',
    summary: 'One run webhook.',
  }),
  op({
    method: 'patch', path: '/run-webhooks/{id}', operationId: 'updateRunWebhook', tag: 'hooks', scope: 'run',
    summary: "Change a run webhook's URL, or whether it hears about every run.",
    body: z.object({ url: url.optional(), every_run: everyRun.optional() }),
  }),
  op({
    method: 'delete', path: '/run-webhooks/{id}', operationId: 'deleteRunWebhook', tag: 'hooks', scope: 'run',
    summary: "Delete a run webhook and its log. Runs that named it just aren't told.", conflict: false,
  }),
  op({
    method: 'post', path: '/run-webhooks/{id}/secret', operationId: 'newRunWebhookSecret', tag: 'hooks',
    scope: 'run', summary: 'Make a new signing secret, shown once. The old one stops signing at once.', conflict: false,
  }),
  op({
    method: 'get', path: '/run-webhooks/{id}/deliveries', operationId: 'listRunWebhookDeliveries', tag: 'hooks',
    scope: 'read', summary: "A run webhook's last deliveries, newest first.",
  }),
  op({
    method: 'post', path: '/run-webhooks/{id}/test', operationId: 'testRunWebhook', tag: 'hooks', scope: 'run',
    summary: 'Send a signed test notice now, once, and say how it went.', conflict: false,
  }),
];
