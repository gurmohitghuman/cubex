import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { reorderSheetColumns } from '../services/column-reorder';

// PUT /:id/columns/reorder — MUST be mounted BEFORE the rename router so
// Express matches /reorder before the /:columnName wildcard (see sheets.ts).
// Validation + write shared with /api/v1 in services/column-reorder.ts.
const router = express.Router();
router.use(authenticateToken);

router.put('/:id/columns/reorder', (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const sheet = verifySheetOwnership(id, req.userId!);
    if (!sheet) return res.status(404).json({ error: 'Sheet not found' });

    const result = reorderSheetColumns(id, req.userId!, (req.body as { columnOrder?: unknown }).columnOrder);
    if ('fail' in result) return res.status(400).json({ error: result.error });
    res.json({ message: 'Column order updated successfully' });
  } catch (error) {
    console.error('Reorder columns error:', error);
    res.status(500).json({ error: 'Failed to reorder columns' });
  }
});

export default router;
