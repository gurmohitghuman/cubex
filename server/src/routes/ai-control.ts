import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { pauseRun, resumeRun, cancelRun } from '../services/run-lifecycle';

// Thin wrappers over services/run-lifecycle.ts (shared with /api/v1 and the
// MCP control_run tool), preserving the historical UI status codes: pause and
// cancel are idempotent 200s (a no-op flip still "succeeded" from the UI's
// point of view); resume distinguishes not-paused (400) from a lost
// compare-and-set race against a cancel (409).
const router = express.Router();
router.use(authenticateToken);

router.post('/runs/:id/pause', (req: AuthRequest, res) => {
  try {
    const result = pauseRun('ai', req.params.id, req.userId!);
    if ('fail' in result) return res.status(result.fail === 'not_found' ? 404 : 409).json({ error: result.message });
    res.json({ message: 'AI run paused' });
  } catch (error) {
    console.error('Pause AI run error:', error);
    res.status(500).json({ error: 'Failed to pause AI run' });
  }
});

router.post('/runs/:id/resume', async (req: AuthRequest, res) => {
  try {
    // Cookie/UI caller is the account owner: full authority to resolve keys.
    const result = await resumeRun('ai', req.params.id, req.userId!, true);
    if ('fail' in result) {
      if (result.fail === 'conflict') return res.status(409).json({ error: 'Run is no longer paused' });
      return res.status(400).json({ error: 'Run is not paused' });
    }
    res.json({ message: 'AI run resumed' });
  } catch (error) {
    console.error('Resume AI run error:', error);
    res.status(500).json({ error: 'Failed to resume AI run' });
  }
});

router.post('/runs/:id/cancel', async (req: AuthRequest, res) => {
  try {
    await cancelRun('ai', req.params.id, req.userId!);
    res.json({ message: 'AI run cancelled' });
  } catch (error) {
    console.error('Cancel AI run error:', error);
    res.status(500).json({ error: 'Failed to cancel AI run' });
  }
});

export default router;
