// /api/v1 setup versions of a sheet: list, save, read one with what restoring
// it would do (?compare is the default), rename or describe, delete, restore.
// Thin wrappers over the services the app and MCP use
// (services/setup-version-*.ts). Restoring sets what runs and auto-run will
// do, so it needs 'run' as well as 'write' ('secrets' when a request it puts
// back reads saved keys); dry_run: true only reads. A request body never
// shows here: a comparison says it changed.
import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { runFailHttpStatus, type RunFail } from '../services/run-shared';
import {
  deleteSetupVersion, listSetupVersions, saveSetupVersion, updateSetupVersion,
} from '../services/setup-version-store';
import { restoreSetupVersion } from '../services/setup-version-restore';
import { flagOf } from '../lib/enrich-agent-input';

const router = express.Router();

const reply = (res: express.Response, out: { ok: unknown } | RunFail, status = 200) =>
  ('fail' in out ? res.status(runFailHttpStatus(out)).json({ error: out.message }) : res.status(status).json(out.ok));
const body = (req: TokenAuthRequest) =>
  (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;

type Handler = (req: TokenAuthRequest, res: express.Response) => unknown;
const guarded = (route: string, fn: Handler): Handler => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    console.error(`${route} error:`, error);
    if (!res.headersSent) res.status(500).json({ error: 'Setup version request failed' });
  }
};

const BASE = '/sheets/:id/setup-versions';

router.get(BASE, requireScope('read'), guarded(`GET /v1${BASE}`, (req, res) => {
  const versions = listSetupVersions(req.params.id, req.userId!);
  return versions ? res.json({ versions }) : res.status(404).json({ error: 'Sheet not found' });
}));

// Body: { name, description? }.
router.post(BASE, requireScope('write'), guarded(`POST /v1${BASE}`, (req, res) => {
  const b = body(req);
  const out = saveSetupVersion(req.params.id, req.userId!, { name: b.name, description: b.description });
  return reply(res, 'ok' in out ? { ok: { version: out.ok } } : out, 201);
}));

router.get(`${BASE}/:versionId`, requireScope('read'), guarded(`GET /v1${BASE}/:versionId`, async (req, res) =>
  reply(res, await restoreSetupVersion(req.params.id, req.userId!, req.params.versionId,
    { dryRun: true, hasSecretsScope: !!req.tokenScopes?.has('secrets'), reveal: false }))));

// Body: any of { name, description }.
router.patch(`${BASE}/:versionId`, requireScope('write'), guarded(`PATCH /v1${BASE}/:versionId`, (req, res) => {
  const b = body(req);
  const out = updateSetupVersion(req.params.id, req.userId!, req.params.versionId,
    { name: b.name, description: b.description });
  return reply(res, 'ok' in out ? { ok: { version: out.ok } } : out);
}));

router.delete(`${BASE}/:versionId`, requireScope('write'), guarded(`DELETE /v1${BASE}/:versionId`, (req, res) => {
  const out = deleteSetupVersion(req.params.id, req.userId!, req.params.versionId);
  return reply(res, 'ok' in out ? { ok: { ok: true } } : out);
}));

// Body: { dry_run? } (false by default here; true or "true" only says what it would do).
router.post(`${BASE}/:versionId/restore`, requireScope('read'), guarded(`POST /v1${BASE}/:versionId/restore`,
  async (req, res) => {
    const flag = flagOf(body(req).dry_run);
    if (flag === 'invalid') return res.status(400).json({ error: 'dry_run must be true or false.' });
    const dryRun = flag === true;
    for (const scope of dryRun ? [] : ['write', 'run'] as const) {
      if (!req.tokenScopes?.has(scope)) {
        return res.status(403).json({ error: `This action requires the '${scope}' scope` });
      }
    }
    return reply(res, await restoreSetupVersion(req.params.id, req.userId!, req.params.versionId,
      { dryRun, hasSecretsScope: !!req.tokenScopes?.has('secrets'), reveal: false }));
  }));

export default router;
