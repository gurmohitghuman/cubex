// /api/v1 routes: "run finished" webhooks (run-webhooks-routes.ts, mounted by
// api-v1.ts at /run-webhooks).
import { z } from 'zod';
import { op, type RouteDoc } from './route-doc';

const url = z.string().describe('A public http(s) address. Private and local addresses are refused.');
const everyRun = z.boolean().describe('true: told when any run finishes. false: only runs that name it.');

export const hookRoutes = (): RouteDoc[] => [
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
