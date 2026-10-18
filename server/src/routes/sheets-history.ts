// A sheet's change log for its History panel (cookie session):
// GET /api/sheets/:id/history?before=&limit=&column=. services/sheet-history.ts
// reads it for every surface.
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { historyAsk, readSheetHistory } from '../services/sheet-history';

const router = express.Router();
router.use(authenticateToken);

router.get('/:id/history', (req: AuthRequest, res) => {
  try {
    if (!verifySheetOwnership(req.params.id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
    const ask = historyAsk(req.query as Record<string, unknown>);
    if ('error' in ask) return res.status(400).json({ error: ask.error });
    res.json(readSheetHistory(req.params.id, req.userId!, ask));
  } catch (error) {
    console.error('Sheet history error:', error);
    res.status(500).json({ error: 'Failed to read the history' });
  }
});

export default router;
