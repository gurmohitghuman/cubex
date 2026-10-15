// The app's Remove duplicates dialog: a check while the person picks columns
// (stopped when they change them or close the dialog), then the removal.
// Both share their implementation with /api/v1 and MCP (services/dedupe-*.ts).
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { runFailHttpStatus } from '../services/run-shared';
import { checkDuplicates } from '../services/dedupe-check';
import { removeDuplicates } from '../services/dedupe-remove';

const router = express.Router();
router.use(authenticateToken);

const bodyOf = (req: AuthRequest): Record<string, unknown> | null => {
  const b = req.body as unknown;
  return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : null;
};

// POST /:id/duplicates/check {columns, keep}: counts and sample groups, nothing changed.
router.post('/:id/duplicates/check', async (req: AuthRequest, res) => {
  try {
    const body = bodyOf(req);
    if (!body) return res.status(400).json({ error: 'Send a JSON object.' });
    const asker = new AbortController();
    res.on('close', () => { if (!res.writableEnded) asker.abort(); });
    const out = await checkDuplicates(req.userId!, req.params.id, { columns: body.columns, keep: body.keep },
      asker.signal);
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    res.json(out.ok);
  } catch (error) {
    console.error('Duplicate check error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to check for duplicates' });
  }
});

// POST /:id/duplicates/remove {columns, keep}: removes them. A paused run
// holding the sheet comes back as blockingRun, so the grid offers "Cancel it".
router.post('/:id/duplicates/remove', async (req: AuthRequest, res) => {
  try {
    const body = bodyOf(req);
    if (!body) return res.status(400).json({ error: 'Send a JSON object.' });
    const out = await removeDuplicates(req.userId!, req.params.id, { columns: body.columns, keep: body.keep });
    if ('fail' in out) {
      return res.status(runFailHttpStatus(out)).json({
        error: out.message, ...(out.busy ? { busy: true } : {}),
        ...(out.blockingRun ? { blockingRun: out.blockingRun } : {}),
      });
    }
    res.json(out.ok);
  } catch (error) {
    console.error('Remove duplicates error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to remove duplicates' });
  }
});

export default router;
