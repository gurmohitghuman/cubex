import express from 'express';
import { db } from '../lib/db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { pauseRun, resumeRun, cancelRun } from '../services/run-lifecycle';
import { type HTTPRunRow } from '../services/http-runner';

// HTTP run control + run reads — split out of http-jobs.ts (200-line rule;
// that file keeps the SSE stream). Control is a thin wrapper over
// services/run-lifecycle.ts (shared with /api/v1 and MCP), preserving the
// historical UI codes: pause/cancel are idempotent 200s; resume distinguishes
// not-paused (400) from a lost CAS race against a cancel (409).
const router = express.Router();

router.post('/jobs/:id/control', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { action } = req.body;

    switch (action) {
      case 'pause': {
        const result = pauseRun('http', id, req.userId!);
        if ('fail' in result) return res.status(result.fail === 'not_found' ? 404 : 409).json({ error: result.message });
        res.json({ message: 'HTTP run paused' });
        break;
      }

      case 'resume': {
        // Cookie/UI caller is the account owner: full authority to resolve keys.
        const result = await resumeRun('http', id, req.userId!, true);
        if ('fail' in result) {
          if (result.fail === 'conflict') return res.status(409).json({ error: 'Run is no longer paused' });
          return res.status(400).json({ error: 'Run not found or not paused' });
        }
        res.json({ message: 'HTTP run resumed' });
        break;
      }

      case 'cancel':
        await cancelRun('http', id, req.userId!);
        res.json({ message: 'HTTP run cancelled' });
        break;

      default:
        res.status(400).json({ error: 'Invalid action' });
    }
  } catch (error: any) {
    console.error('HTTP job control error:', error);
    res.status(500).json({ error: 'Failed to control HTTP job' });
  }
});

router.get('/runs', authenticateToken, (req: AuthRequest, res) => {
  try {
    const { sheetId } = req.query as { sheetId?: string };
    if (!sheetId) return res.status(400).json({ error: 'sheetId is required' });
    const runs = db.prepare('SELECT * FROM http_runs WHERE sheet_id = ? AND user_id = ? ORDER BY created_at DESC')
      .all(sheetId, req.userId!);
    res.json(runs);
  } catch (error: any) {
    console.error('Get HTTP runs error:', error);
    res.status(500).json({ error: 'Failed to get HTTP runs' });
  }
});

router.get('/jobs/:id', authenticateToken, (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const run = db.prepare('SELECT * FROM http_runs WHERE id = ? AND user_id = ?')
      .get(id, req.userId!) as HTTPRunRow | undefined;
    if (!run) return res.status(404).json({ error: 'HTTP run not found' });

    const results = db.prepare('SELECT * FROM http_results WHERE run_id = ? AND user_id = ? ORDER BY row_index ASC')
      .all(id, req.userId!);
    res.json({ ...run, results });
  } catch (error: any) {
    console.error('Get HTTP run details error:', error);
    res.status(500).json({ error: 'Failed to get HTTP run details' });
  }
});

export default router;
