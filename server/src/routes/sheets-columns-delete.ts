import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { deleteSheetColumn } from '../services/column-delete';
import { getTrashDays } from '../lib/trash/store';

// DELETE /:id/columns/:columnName — the cascade implementation (rows.data key,
// column_order, filters, HTTP/webhook refs, run + webhook-marker +
// last-column guards) is shared with /api/v1 in services/column-delete.ts.
// Answers where it went: `trash` ({ id, days }, as a row or sheet delete
// answers the app, and moving: true while its cells are still going there),
// or null when Settings keeps deleted things 0 days.
const router = express.Router();
router.use(authenticateToken);

router.delete('/:id/columns/:columnName', async (req: AuthRequest, res) => {
  try {
    const { id, columnName } = req.params;
    const sheet = verifySheetOwnership(id, req.userId!);
    if (!sheet) return res.status(404).json({ error: 'Sheet not found' });

    const result = await deleteSheetColumn(id, req.userId!, columnName);
    if ('fail' in result) {
      switch (result.fail) {
        case 'column_not_found':
          return res.status(404).json({ error: `Column "${columnName}" not found in this sheet.` });
        case 'active_run':
        case 'busy':
          return res.status(409).json({ error: result.error });
        default: // 'webhook_column' | 'last_column' — historical UI status is 400
          return res.status(400).json({ error: result.error });
      }
    }
    res.json({
      message: 'Column deleted successfully',
      trash: result.trashId === null ? null
        : { id: result.trashId, days: getTrashDays(req.userId!), ...(result.moving ? { moving: true } : {}) },
    });
  } catch (error) {
    console.error('Delete column error:', error);
    res.status(500).json({ error: 'Failed to delete column' });
  }
});

export default router;
