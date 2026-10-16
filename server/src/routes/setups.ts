// The app's setups library (/api/setups): list, read, rename or describe,
// delete, export as a file and import one. Saving from a sheet is
// sheets-setups.ts. One implementation with /api/v1 and MCP
// (services/setup-library.ts, setup-files.ts).
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { runFailHttpStatus } from '../services/run-shared';
import { deleteSetup, getSetup, listSetups, updateSetup } from '../services/setup-library';
import { exportSetup, importSetup } from '../services/setup-files';

const router = express.Router();
router.use(authenticateToken);

type Handler = (req: AuthRequest, res: express.Response) => void;
const guarded = (what: string, fn: Handler): Handler => (req, res) => {
  try {
    fn(req, res);
  } catch (error) {
    console.error(`Setups: ${what} error:`, error);
    if (!res.headersSent) res.status(500).json({ error: `Failed to ${what}` });
  }
};

router.get('/', guarded('list setups', (req, res) => { res.json({ setups: listSetups(req.userId!) }); }));

router.post('/import', guarded('import the setup', (req, res) => {
  const out = importSetup(req.userId!, req.body);
  if ('fail' in out) return void res.status(runFailHttpStatus(out)).json({ error: out.message });
  res.status(201).json(out.ok);
}));

router.get('/:id', guarded('read the setup', (req, res) => {
  const setup = getSetup(req.userId!, req.params.id);
  if (!setup) return void res.status(404).json({ error: 'Setup not found' });
  res.json(setup);
}));

router.get('/:id/export', guarded('export the setup', (req, res) => {
  const out = exportSetup(req.userId!, req.params.id);
  if ('fail' in out) return void res.status(runFailHttpStatus(out)).json({ error: out.message });
  res.json(out.ok);
}));

router.patch('/:id', guarded('change the setup', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const out = updateSetup(req.userId!, req.params.id, { name: b.name, description: b.description });
  if ('fail' in out) return void res.status(runFailHttpStatus(out)).json({ error: out.message });
  res.json(out.ok);
}));

router.delete('/:id', guarded('delete the setup', (req, res) => {
  const out = deleteSetup(req.userId!, req.params.id);
  if ('fail' in out) return void res.status(runFailHttpStatus(out)).json({ error: out.message });
  res.json(out.ok);
}));

export default router;
