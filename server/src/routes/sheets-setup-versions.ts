// A sheet's setup versions in the app (services/setup-version-*.ts): list,
// save, rename or describe, delete, compare one with the sheet now (a dry
// restore), restore. REST v1: api-v1-setup-versions.ts; MCP:
// tools-setup-versions.ts. The app is the owner: a request body shows in a
// comparison, as the HTTP dialog shows it.
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { runFailHttpStatus, type RunFail } from '../services/run-shared';
import {
  deleteSetupVersion, listSetupVersions, saveSetupVersion, updateSetupVersion,
} from '../services/setup-version-store';
import { restoreSetupVersion } from '../services/setup-version-restore';

const router = express.Router();
router.use(authenticateToken);

const reply = (res: express.Response, out: { ok: unknown } | RunFail, status = 200) =>
  ('fail' in out ? res.status(runFailHttpStatus(out)).json({ error: out.message }) : res.status(status).json(out.ok));

type Handler = (req: AuthRequest, res: express.Response) => unknown;
const guarded = (label: string, fn: Handler): Handler => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    console.error(`${label} error:`, error);
    if (!res.headersSent) res.status(500).json({ error: `Failed to ${label}` });
  }
};

router.get('/:id/setup-versions', guarded('list setup versions', (req, res) => {
  const versions = listSetupVersions(req.params.id, req.userId!);
  return versions ? res.json({ versions }) : res.status(404).json({ error: 'Sheet not found' });
}));

// Body: { name, description? }.
router.post('/:id/setup-versions', guarded('save the setup version', (req, res) => {
  const b = req.body ?? {};
  const out = saveSetupVersion(req.params.id, req.userId!, { name: b.name, description: b.description });
  return reply(res, 'ok' in out ? { ok: { version: out.ok } } : out, 201);
}));

// The version against the sheet now: what restoring it would do.
router.get('/:id/setup-versions/:versionId', guarded('compare the setup version', async (req, res) =>
  reply(res, await restoreSetupVersion(req.params.id, req.userId!, req.params.versionId,
    { dryRun: true, hasSecretsScope: true, reveal: true }))));

// Body: any of { name, description }.
router.patch('/:id/setup-versions/:versionId', guarded('update the setup version', (req, res) => {
  const b = req.body ?? {};
  const out = updateSetupVersion(req.params.id, req.userId!, req.params.versionId,
    { name: b.name, description: b.description });
  return reply(res, 'ok' in out ? { ok: { version: out.ok } } : out);
}));

router.delete('/:id/setup-versions/:versionId', guarded('delete the setup version', (req, res) => {
  const out = deleteSetupVersion(req.params.id, req.userId!, req.params.versionId);
  return reply(res, 'ok' in out ? { ok: { ok: true } } : out);
}));

router.post('/:id/setup-versions/:versionId/restore', guarded('restore the setup version', async (req, res) =>
  reply(res, await restoreSetupVersion(req.params.id, req.userId!, req.params.versionId,
    { dryRun: false, hasSecretsScope: true, reveal: true }))));

export default router;
