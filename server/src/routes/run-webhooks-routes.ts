// "Run finished" webhooks over HTTP, for both surfaces: Settings (cookie
// session, /api/settings/run-webhooks) and /api/v1/run-webhooks (access
// tokens: reading needs 'read'; adding, changing, deleting, a new secret and a
// test need 'run', since they decide where Cubex sends requests, as an HTTP
// API column does). Thin wrappers over
// services/run-hooks.ts, so the app and the API can't drift; only the auth
// guard differs. A secret is in the answer only when it was just made.
import express from 'express';
import {
  createRunWebhook, deleteRunWebhook, getRunWebhook, listRunWebhooks, newRunWebhookSecret, runWebhookDeliveries,
  testRunWebhook, updateRunWebhook, type HookFail,
} from '../services/run-hooks';

type Scope = 'read' | 'run';
type Req = express.Request & { userId?: string };

const STATUS: Record<HookFail['fail'], number> = { bad_request: 400, not_found: 404, conflict: 409 };
const body = (req: Req) =>
  (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;

export function runWebhookRoutes(base: string, allow: (scope: Scope) => express.RequestHandler): express.Router {
  const router = express.Router();
  const guarded = (route: string, fn: (req: Req, res: express.Response) => unknown) =>
    async (req: Req, res: express.Response) => {
      try {
        await fn(req, res);
      } catch (error) {
        console.error(`${route} error:`, error);
        if (!res.headersSent) res.status(500).json({ error: 'Run webhook request failed' });
      }
    };
  const reply = (res: express.Response, out: { ok: unknown } | HookFail, created = false) =>
    ('fail' in out ? res.status(STATUS[out.fail]).json({ error: out.message })
      : res.status(created ? 201 : 200).json(out.ok));

  router.get(base, allow('read'), guarded(`GET ${base}`, (req, res) =>
    res.json({ webhooks: listRunWebhooks(req.userId!) })));

  // Body: { url, every_run? (default true) }. 201: { webhook, secret } (the only time the secret is shown).
  router.post(base, allow('run'), guarded(`POST ${base}`, async (req, res) =>
    reply(res, await createRunWebhook(req.userId!, body(req)), true)));

  router.get(`${base}/:id`, allow('read'), guarded(`GET ${base}/:id`, (req, res) => {
    const hook = getRunWebhook(req.userId!, req.params.id);
    return hook ? res.json(hook) : res.status(404).json({ error: 'Run webhook not found' });
  }));

  // Body: { url?, every_run? }.
  router.patch(`${base}/:id`, allow('run'), guarded(`PATCH ${base}/:id`, async (req, res) =>
    reply(res, await updateRunWebhook(req.userId!, req.params.id, body(req)))));

  router.delete(`${base}/:id`, allow('run'), guarded(`DELETE ${base}/:id`, (req, res) =>
    (deleteRunWebhook(req.userId!, req.params.id)
      ? res.json({ deleted: true }) : res.status(404).json({ error: 'Run webhook not found' }))));

  // A new signing secret, shown once; the old one stops at once.
  router.post(`${base}/:id/secret`, allow('run'), guarded(`POST ${base}/:id/secret`, (req, res) =>
    reply(res, newRunWebhookSecret(req.userId!, req.params.id))));

  // The last deliveries, newest first.
  router.get(`${base}/:id/deliveries`, allow('read'), guarded(`GET ${base}/:id/deliveries`, (req, res) => {
    const list = runWebhookDeliveries(req.userId!, req.params.id);
    return list ? res.json({ deliveries: list }) : res.status(404).json({ error: 'Run webhook not found' });
  }));

  // Sends a signed "test" notice now and answers with how it went.
  router.post(`${base}/:id/test`, allow('run'), guarded(`POST ${base}/:id/test`, async (req, res) =>
    reply(res, await testRunWebhook(req.userId!, req.params.id))));

  return router;
}
