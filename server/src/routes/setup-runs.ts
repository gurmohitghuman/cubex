// A setup being used on a sheet (/api/setup-runs): its state, and pausing,
// resuming or stopping it. One implementation with /api/v1 and MCP
// (services/setup-run-store.ts, setup-run-control.ts).
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { runFailHttpStatus } from '../services/run-shared';
import { getSetupRun } from '../services/setup-run-store';
import { controlSetupRun, type SetupRunAction } from '../services/setup-run-control';

const router = express.Router();
router.use(authenticateToken);
const ACTIONS: SetupRunAction[] = ['pause', 'resume', 'cancel'];

router.get('/:id', (req: AuthRequest, res) => {
  const run = getSetupRun(req.userId!, req.params.id);
  if (!run) return res.status(404).json({ error: 'Setup run not found' });
  res.json(run);
});

router.post('/:id/:action', async (req: AuthRequest, res) => {
  try {
    const action = req.params.action as SetupRunAction;
    if (!ACTIONS.includes(action)) return res.status(404).json({ error: 'Not found' });
    const out = await controlSetupRun(req.userId!, req.params.id, action, true);
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    res.json(out.ok);
  } catch (error) {
    console.error('Setup run control error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to change the setup run' });
  }
});

export default router;
