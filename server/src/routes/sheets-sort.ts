import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { physicalSortSheet } from '../services/sheet-sort';

const router = express.Router();
router.use(authenticateToken);

// POST /:id/sort — Google Sheets semantics: physically reorder row_index so
// the sorted order BECOMES the sheet's row order, then forget the sort.
// Rows never move again on later edits (there is no live view-sort anywhere;
// the old persistent sort_state re-sorted on every edit, so clearing a cell
// in the sorted column teleported its row — users read that as data loss).
// Implementation shared with /api/v1 in services/sheet-sort.ts.
router.post('/:id/sort', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { column, direction } = req.body as { column?: unknown; direction?: unknown };
    if (typeof column !== 'string' || !column) {
      return res.status(400).json({ error: 'column is required (string).' });
    }
    if (direction !== 'asc' && direction !== 'desc') {
      return res.status(400).json({ error: "direction must be 'asc' or 'desc'." });
    }

    const sheet = verifySheetOwnership(id, req.userId!);
    if (!sheet) return res.status(404).json({ error: 'Sheet not found' });

    const result = await physicalSortSheet(id, req.userId!, column, direction);
    if ('fail' in result) {
      if (result.fail === 'busy') return res.status(409).json({ error: result.error, busy: true });
      if (result.fail === 'column_not_found') {
        return res.status(404).json({ error: `Column "${column}" not found in this sheet.` });
      }
      return res.status(409).json({
        error: 'Cannot sort while a run is active on this sheet. Stop or finish the run first.',
      });
    }
    res.json({ message: 'Sheet sorted', rowsReordered: result.rowsReordered });
  } catch (error) {
    console.error('Sort sheet error:', error);
    res.status(500).json({ error: 'Failed to sort sheet' });
  }
});

export default router;
