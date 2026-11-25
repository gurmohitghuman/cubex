// Scheduled reruns of a sheet's (or a table's) run columns: ONE set of routes for the app (Settings' router, the
// session cookie) and /api/v1/run-schedules (an access token's scopes), as run-webhooks-routes.ts does. Thin
// wrappers over services/run-schedule-store.ts and run-schedule-fire.ts, which MCP's manage_run_schedule uses too.
// A list for one sheet also answers its run columns (what a schedule can name).
import express from 'express';
import type { TokenAuthRequest } from '../middleware/access-token-auth';
import { runFailHttpStatus, type RunFail } from '../services/run-shared';
import {
  changeSchedule, createSchedule, deleteSchedule, listSchedules, loadSchedule, pauseSchedule, scheduleView,
} from '../services/run-schedule-store';
import { fireScheduleNow, sheetRunColumns } from '../services/run-schedule-fire';
import { estimateScheduleFiring } from '../services/run-schedule-estimate';
import { verifySheetOwnership } from '../lib/sql-helpers';

type Scope = 'read' | 'run';
type Out = { ok: unknown } | RunFail;
const reply = (res: express.Response, out: Out, created = false) => {
  if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
  return res.status(created ? 201 : 200).json(out.ok);
};
const body = (req: TokenAuthRequest) =>
  (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;
type Handler = (req: TokenAuthRequest, res: express.Response) => unknown;
const guarded = (route: string, fn: Handler): Handler => async (req, res) => {
  try { await fn(req, res); } catch (error) {
    console.error(`${route} error:`, error);
    if (!res.headersSent) res.status(500).json({ error: 'Schedule request failed' });
  }
};
const q = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
// The app's session may use saved keys; a token only with 'secrets'.
const secrets = (req: TokenAuthRequest) => (req.tokenScopes ? req.tokenScopes.has('secrets') : true);

export function runScheduleRoutes(base: string, allow: (scope: Scope) => express.RequestHandler): express.Router {
  const router = express.Router();

  // ?sheet_id= (with its table's) or ?table_id=: those only.
  router.get(base, allow('read'), guarded(`GET ${base}`, (req, res) => {
    const sheetId = q(req.query.sheet_id);
    const runColumns = sheetId && verifySheetOwnership(sheetId, req.userId!)
      ? { run_columns: sheetRunColumns(sheetId, req.userId!) } : {};
    const schedules = listSchedules(req.userId!, { sheetId, tableId: q(req.query.table_id) });
    return res.json({ schedules, ...runColumns });
  }));

  router.get(`${base}/:id`, allow('read'), guarded(`GET ${base}/:id`, (req, res) => {
    const s = loadSchedule(req.userId!, req.params.id);
    return s ? res.json(scheduleView(s)) : res.status(404).json({ error: 'Schedule not found' });
  }));

  router.post(base, allow('run'), guarded(`POST ${base}`, (req, res) =>
    reply(res, createSchedule(req.userId!, body(req), { hasSecretsScope: secrets(req) }), true)));

  // The fields to change, and paused: true or false to pause or resume.
  router.patch(`${base}/:id`, allow('run'), guarded(`PATCH ${base}/:id`, (req, res) => {
    const { paused, ...fields } = body(req);
    if (paused !== undefined && typeof paused !== 'boolean') {
      return res.status(400).json({ error: 'paused must be true or false.' });
    }
    if (Object.keys(fields).length) {
      const changed = changeSchedule(req.userId!, req.params.id, fields, { hasSecretsScope: secrets(req) });
      if ('fail' in changed || paused === undefined) return reply(res, changed);
    }
    return paused === undefined ? reply(res, { fail: 'bad_request', message: 'Nothing to change.' })
      : reply(res, pauseSchedule(req.userId!, req.params.id, paused, { hasSecretsScope: secrets(req) }));
  }));

  router.delete(`${base}/:id`, allow('run'), guarded(`DELETE ${base}/:id`, (req, res) =>
    reply(res, deleteSchedule(req.userId!, req.params.id))));

  // What firing it now would cost, as the caller (fire now runs as them): nothing starts.
  router.get(`${base}/:id/estimate`, allow('run'), guarded(`GET ${base}/:id/estimate`, async (req, res) =>
    reply(res, await estimateScheduleFiring(req.userId!, req.params.id, { hasSecretsScope: secrets(req) }))));

  // Fire it once now; its next time stays as it was.
  router.post(`${base}/:id/fire`, allow('run'), guarded(`POST ${base}/:id/fire`,
    async (req, res) => reply(res, await fireScheduleNow(req.userId!, req.params.id,
      { hasSecretsScope: secrets(req) }))));
  return router;
}
