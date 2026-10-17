import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { streamSheetCsv } from '../lib/csv-export';

const router = express.Router();
router.use(authenticateToken);

// CSV building (incl. formula-injection escaping) is shared with /api/v1 —
// see lib/csv-export.ts. Streamed: a million-row sheet downloads in pages.
// ?view=active exports the view the grid shows: its rows and visible columns.
router.get('/:id/export', async (req: AuthRequest, res) => {
  try {
    const view = typeof req.query.view === 'string' && req.query.view.trim() ? req.query.view : undefined;
    const result = await streamSheetCsv(req.params.id, req.userId!, res, { view });
    if (result === 'not_found') return res.status(404).json({ error: 'Sheet not found' });
    if (result === 'empty') return res.status(400).json({ error: 'No data to export' });
    if (typeof result === 'object' && 'invalid' in result) return res.status(400).json({ error: result.invalid });
    if (typeof result === 'object') return res.status(409).json({ error: result.busy, busy: true });
  } catch (error) {
    console.error('Export CSV error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to export CSV' });
    else res.destroy();
  }
});

export default router;
