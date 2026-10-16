// /api/v1 setups: the library (list, read, rename or describe, delete, export,
// import) and saving one from a sheet. Thin wrappers over the services the app
// and the MCP tools use (services/setup-library.ts, setup-save.ts,
// setup-files.ts), so the surfaces can't drift. Saving and its plan only
// read the sheet: allowed while it's busy (api-v1.ts).
import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { runFailHttpStatus, type RunFail } from '../services/run-shared';
import { deleteSetup, getSetup, listSetups, specSummary, updateSetup } from '../services/setup-library';
import { exportSetup, importSetup } from '../services/setup-files';
import { planSetup, saveSetup, sheetSteps } from '../services/setup-save';
import { applySetup } from '../services/setup-apply';
import { applyInputOf } from '../services/setup-apply-input';
import { getSetupRun, sheetSetupRuns } from '../services/setup-run-store';
import { controlSetupRun, type SetupRunAction } from '../services/setup-run-control';

const router = express.Router();

type Out = { ok: unknown } | RunFail;
const reply = (res: express.Response, out: Out, created = false) => {
  if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
  res.status(created ? 201 : 200).json(out.ok);
};
const body = (req: TokenAuthRequest) =>
  (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;

type Handler = (req: TokenAuthRequest, res: express.Response) => unknown;
const guarded = (route: string, fn: Handler): Handler => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    console.error(`${route} error:`, error);
    if (!res.headersSent) res.status(500).json({ error: 'Setup request failed' });
  }
};

router.get('/setups', requireScope('read'), guarded('GET /v1/setups', (req, res) =>
  res.json({ setups: listSetups(req.userId!) })));

router.post('/setups/import', requireScope('write'), guarded('POST /v1/setups/import', (req, res) =>
  reply(res, importSetup(req.userId!, req.body), true)));

router.get('/setups/:setupId', requireScope('read'), guarded('GET /v1/setups/:id', (req, res) => {
  const setup = getSetup(req.userId!, req.params.setupId);
  return setup ? res.json(setup) : res.status(404).json({ error: 'Setup not found' });
}));

router.get('/setups/:setupId/export', requireScope('read'), guarded('GET /v1/setups/:id/export', (req, res) =>
  reply(res, exportSetup(req.userId!, req.params.setupId))));

router.patch('/setups/:setupId', requireScope('write'), guarded('PATCH /v1/setups/:id', (req, res) => {
  const b = body(req);
  return reply(res, updateSetup(req.userId!, req.params.setupId, { name: b.name, description: b.description }));
}));

router.delete('/setups/:setupId', requireScope('write'), guarded('DELETE /v1/setups/:id', (req, res) =>
  reply(res, deleteSetup(req.userId!, req.params.setupId))));

router.get('/sheets/:id/setup-steps', requireScope('read'), guarded('GET /v1/sheets/:id/setup-steps', (req, res) => {
  const out = sheetSteps(req.userId!, req.params.id);
  return 'fail' in out ? reply(res, out) : res.json({ steps: out.ok });
}));

router.post('/sheets/:id/setups/plan', requireScope('read'), guarded('POST /v1/sheets/:id/setups/plan', (req, res) => {
  const b = body(req);
  const out = planSetup(req.userId!, req.params.id, b.columns, b.include_upstream !== false);
  return reply(res, 'fail' in out ? out : { ok: { ...specSummary(out.ok), spec: out.ok } });
}));

router.post('/sheets/:id/setups', requireScope('write'), guarded('POST /v1/sheets/:id/setups', (req, res) => {
  const b = body(req);
  return reply(res, saveSetup(req.userId!, req.params.id, {
    name: b.name, description: b.description, columns: b.columns, includeUpstream: b.include_upstream,
  }), true);
}));

// { inputs, names, models, first_rows, estimate_only }: a price, or the start (201).
router.post('/sheets/:id/setups/:setupId/apply', requireScope('run'),
  guarded('POST /v1/sheets/:id/setups/:setupId/apply', async (req, res) => {
    const input = applyInputOf(body(req), 'v1');
    if ('fail' in input) return reply(res, input);
    const out = await applySetup(req.userId!, req.params.id, req.params.setupId, input,
      { hasSecretsScope: !!req.tokenScopes?.has('secrets') });
    if ('fail' in out) {
      return res.status(runFailHttpStatus(out)).json({ error: out.message, missing: out.missing, taken: out.taken });
    }
    return res.status('setup_run' in out.ok ? 201 : 200).json(out.ok);
  }));

router.get('/sheets/:id/setup-runs', requireScope('read'), guarded('GET /v1/sheets/:id/setup-runs', (req, res) =>
  res.json({ setup_runs: sheetSetupRuns(req.userId!, req.params.id) })));

router.get('/setup-runs/:runId', requireScope('read'), guarded('GET /v1/setup-runs/:id', (req, res) => {
  const run = getSetupRun(req.userId!, req.params.runId);
  return run ? res.json(run) : res.status(404).json({ error: 'Setup run not found' });
}));

// { action: "pause" | "resume" | "cancel" }
router.post('/setup-runs/:runId/control', requireScope('run'), guarded('POST /v1/setup-runs/:id/control',
  async (req, res) => {
    const action = body(req).action;
    if (action !== 'pause' && action !== 'resume' && action !== 'cancel') {
      return res.status(400).json({ error: 'action must be pause, resume or cancel.' });
    }
    return reply(res, await controlSetupRun(req.userId!, req.params.runId, action as SetupRunAction,
      !!req.tokenScopes?.has('secrets')));
  }));

export default router;
