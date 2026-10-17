import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { runFailHttpStatus } from '../services/run-shared';
import { stopSheetRuns } from '../services/sheet-runs-stop';

// POST /:id/runs/stop: the header's "Stop all". Stops every run and setup on
// the sheet and says what it stopped (services/sheet-runs-stop.ts, shared with
// /api/v1 and MCP). Allowed while the sheet is busy: a run still writing its
// placeholders holds it, and stopping that run is the point.
const router = express.Router();
router.use(authenticateToken);

router.post('/:id/runs/stop', async (req: AuthRequest, res) => {
  try {
    const out = await stopSheetRuns(req.userId!, req.params.id);
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    res.json(out.ok);
  } catch (error) {
    console.error('Stop all runs error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to stop the runs' });
  }
});

export default router;
