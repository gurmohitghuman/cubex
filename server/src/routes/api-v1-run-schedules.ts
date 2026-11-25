// /api/v1/run-schedules: scheduled reruns of a sheet's (or a table's) run columns. Thin wrappers over
// services/run-schedule-store.ts and run-schedule-fire.ts, which the app and MCP's manage_run_schedule use too.
import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { runFailHttpStatus, type RunFail } from '../services/run-shared';
import {
  changeSchedule, createSchedule, deleteSchedule, listSchedules, loadSchedule, pauseSchedule, scheduleView,
} from '../services/run-schedule-store';
import { fireScheduleNow } from '../services/run-schedule-fire';

const router = express.Router();
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
const caller = (req: TokenAuthRequest) => ({ hasSecretsScope: !!req.tokenScopes?.has('secrets') });

// ?sheet_id= (with its table's) or ?table_id=: those only.
router.get('/run-schedules', requireScope('read'), guarded('GET /v1/run-schedules', (req, res) =>
  res.json({
    schedules: listSchedules(req.userId!, { sheetId: q(req.query.sheet_id), tableId: q(req.query.table_id) }),
  })));

router.get('/run-schedules/:id', requireScope('read'), guarded('GET /v1/run-schedules/:id', (req, res) => {
  const s = loadSchedule(req.userId!, req.params.id);
  return s ? res.json(scheduleView(s)) : res.status(404).json({ error: 'Schedule not found' });
}));

router.post('/run-schedules', requireScope('run'), guarded('POST /v1/run-schedules', (req, res) =>
  reply(res, createSchedule(req.userId!, body(req), caller(req)), true)));

// The fields to change, and paused: true or false to pause or resume.
router.patch('/run-schedules/:id', requireScope('run'), guarded('PATCH /v1/run-schedules/:id', (req, res) => {
  const { paused, ...fields } = body(req);
  if (paused !== undefined && typeof paused !== 'boolean') {
    return res.status(400).json({ error: 'paused must be true or false.' });
  }
  if (Object.keys(fields).length) {
    const changed = changeSchedule(req.userId!, req.params.id, fields, caller(req));
    if ('fail' in changed || paused === undefined) return reply(res, changed);
  }
  return paused === undefined ? reply(res, { fail: 'bad_request', message: 'Nothing to change.' })
    : reply(res, pauseSchedule(req.userId!, req.params.id, paused, caller(req)));
}));

router.delete('/run-schedules/:id', requireScope('run'), guarded('DELETE /v1/run-schedules/:id', (req, res) =>
  reply(res, deleteSchedule(req.userId!, req.params.id))));

// Fire it once now; its next time stays as it was.
router.post('/run-schedules/:id/fire', requireScope('run'), guarded('POST /v1/run-schedules/:id/fire',
  async (req, res) => reply(res, await fireScheduleNow(req.userId!, req.params.id, caller(req)))));

export default router;
